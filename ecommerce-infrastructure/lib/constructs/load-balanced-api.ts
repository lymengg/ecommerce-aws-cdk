import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { ISecurityGroup, IVpc, Peer, Port, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { IRepository } from 'aws-cdk-lib/aws-ecr';
import {
  Cluster,
  ContainerImage,
  FargateService,
  FargateTaskDefinition,
  LogDrivers,
  PropagatedTagSource,
  Protocol as EcsProtocol,
  Secret as EcsSecret,
} from 'aws-cdk-lib/aws-ecs';
import {
  ApplicationListener,
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  ListenerAction,
  Protocol as ElbProtocol,
  SslPolicy,
  TargetType,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

import { ApplicationConfig } from '../config/types';

/** Port the load balancer accepts public HTTP traffic on. With a certificate it redirects to 443. */
const LISTENER_PORT = 80;

/** Port the load balancer accepts public HTTPS traffic on once a certificate is supplied. */
const HTTPS_LISTENER_PORT = 443;

/**
 * Everything the container needs to reach the database (Phase 3).
 *
 * The host, port and database name are configuration, not secrets, so they travel as ordinary
 * environment variables. Only the user name and password come from Secrets Manager, and they are
 * injected by ECS at container start rather than passed as values.
 */
export interface DatabaseConnection {
  /** RDS endpoint host name. */
  readonly host: string;

  /** RDS endpoint port. */
  readonly port: string;

  /** Name of the database the application connects to. */
  readonly databaseName: string;

  /** Secret holding the `username` and `password` fields. */
  readonly secret: ISecret;
}

export interface LoadBalancedApiProps {
  /** The Phase 1 VPC. The load balancer lands in its public subnets, the tasks in its private ones. */
  readonly vpc: IVpc;

  /** ECS cluster the service is created in. */
  readonly cluster: Cluster;

  /** ECR repository the container image is pulled from. */
  readonly repository: IRepository;

  /** Application tier configuration: sizing, port, health check path, image tag. */
  readonly config: ApplicationConfig;

  /** Name shared by the ECS service, task family, load balancer, target group and log group. */
  readonly serviceName: string;

  /**
   * The Phase 1 load balancer security group, re-imported so that it is *owned by the stack that
   * builds this construct*. CDK creates an added rule as a child of the security group construct,
   * so a rule added to the security group while it still lives in the network stack would end up in
   * the network stack's template. Re-importing keeps the Phase 2 HTTP rule in the Phase 2 stack,
   * where it belongs. See ApplicationStack.
   */
  readonly albSecurityGroup: ISecurityGroup;

  /** The Phase 1 application security group. The ECS tasks carry it, so the ALB can reach them. */
  readonly applicationSecurityGroup: ISecurityGroup;

  /** Where the container finds the database and the secret holding its credentials (Phase 3). */
  readonly database: DatabaseConnection;

  /**
   * ACM certificate covering {@link domainName}. When supplied, the load balancer terminates TLS on
   * 443 and the port 80 listener becomes a permanent redirect. When omitted (dev before a domain
   * has been delegated), the load balancer keeps today's plaintext HTTP path.
   */
  readonly certificate?: ICertificate;

  /**
   * Fully qualified domain name the certificate covers, for example `api.dev.example.com`. Only
   * used to document the listener; the load balancer does not need it to serve the certificate.
   */
  readonly domainName?: string;

  /** Removal policy for resources that support one: the log group. */
  readonly removalPolicy: RemovalPolicy;
}

/**
 * The Phase 2 application tier: a Spring Boot API running as a single Fargate task behind an
 * internet-facing Application Load Balancer, now reading and writing PostgreSQL (Phase 3) and, when
 * a certificate is supplied, terminating TLS (Phase 3.5).
 *
 *   Internet -> ALB (public subnets) -> target group -> ECS service (private subnets) -> Fargate task
 *                                                                                          |
 *                                                                       TCP 5432 (application SG)
 *                                                                                          v
 *                                                                            RDS (isolated subnets)
 *
 * The load balancer is the only internet-facing resource; the task itself has no public address and
 * is reachable only from the load balancer's security group. Everything is wired with L2 constructs,
 * and the ECS service registers and deregisters its task with the target group automatically, so no
 * task IP address is ever managed by hand.
 */
export class LoadBalancedApi extends Construct {
  /** The load balancer serving public traffic. */
  public readonly loadBalancer: ApplicationLoadBalancer;

  /** Target group the ECS service registers its tasks with. */
  public readonly targetGroup: ApplicationTargetGroup;

  /**
   * Port 80 listener. Forwards to {@link targetGroup} when no certificate is configured; with a
   * certificate it answers a permanent redirect to HTTPS instead, so no plaintext request reaches
   * the application.
   */
  public readonly listener: ApplicationListener;

  /**
   * Port 443 listener that terminates TLS with {@link LoadBalancedApiProps.certificate} and forwards
   * to {@link targetGroup}. Absent when no certificate is configured.
   */
  public readonly httpsListener?: ApplicationListener;

  /** The ECS service running the API. */
  public readonly service: FargateService;

  /** The Fargate task definition. */
  public readonly taskDefinition: FargateTaskDefinition;

  /** CloudWatch log group the container logs to. */
  public readonly logGroup: LogGroup;

  /** Role ECS assumes to pull the image and write logs. Owned by the ECS agent, not the app. */
  public readonly executionRole: Role;

  /** Role the application itself assumes. Deliberately permissionless in this phase. */
  public readonly taskRole: Role;

  constructor(scope: Construct, id: string, props: LoadBalancedApiProps) {
    super(scope, id);

    const { vpc, cluster, repository, config, serviceName, albSecurityGroup, applicationSecurityGroup, database } =
      props;

    this.logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/${serviceName}`,
      retention: config.logRetention,
      removalPolicy: props.removalPolicy,
    });

    this.executionRole = this.createExecutionRole(repository, database);
    this.taskRole = this.createTaskRole();
    this.taskDefinition = this.createTaskDefinition(serviceName, repository, config, database);

    this.loadBalancer = new ApplicationLoadBalancer(this, 'LoadBalancer', {
      loadBalancerName: `${serviceName}-alb`,
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      // Only the public subnets have a route to the internet gateway, which an internet-facing ALB
      // needs in both directions.
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      // Deletion protection follows the environment's removal policy: dev can be torn down, uat and
      // prod cannot lose the endpoint to an accidental `cdk destroy`.
      deletionProtection: props.removalPolicy === RemovalPolicy.RETAIN,
    });

    this.targetGroup = new ApplicationTargetGroup(this, 'TargetGroup', {
      targetGroupName: `${serviceName}-tg`,
      vpc,
      port: config.containerPort,
      protocol: ApplicationProtocol.HTTP,
      // Fargate tasks use the awsvpc network mode, so targets are addressed by IP, never by instance
      // id. The ECS service keeps the registration up to date as tasks come and go.
      targetType: TargetType.IP,
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        path: config.healthCheckPath,
        protocol: ElbProtocol.HTTP,
        healthyHttpCodes: '200',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // `open: false` keeps the listeners from quietly adding a 0.0.0.0/0 rule; the ingress rules
    // below are added explicitly instead, so the public entry points are visible in the template.
    if (props.certificate === undefined) {
      // No certificate yet (dev before a domain has been delegated): the plaintext Phase 2 path.
      this.listener = this.loadBalancer.addListener('HttpListener', {
        port: LISTENER_PORT,
        protocol: ApplicationProtocol.HTTP,
        defaultTargetGroups: [this.targetGroup],
        open: false,
      });
    } else {
      // With a certificate, port 80 only redirects. A redirect action keeps the plaintext listener
      // out of the request path entirely - it never forwards to the target group, so no request
      // reaches the application unencrypted.
      this.listener = this.loadBalancer.addListener('HttpListener', {
        port: LISTENER_PORT,
        protocol: ApplicationProtocol.HTTP,
        defaultAction: ListenerAction.redirect({
          port: String(HTTPS_LISTENER_PORT),
          protocol: ApplicationProtocol.HTTPS,
          permanent: true,
        }),
        open: false,
      });

      // TLS terminates at the load balancer and the request continues to the task over plain HTTP
      // inside the private subnets, which is standard: the hop that crosses the internet is the one
      // that must be encrypted, and the target group is not reachable from outside the VPC.
      this.httpsListener = this.loadBalancer.addListener('HttpsListener', {
        port: HTTPS_LISTENER_PORT,
        protocol: ApplicationProtocol.HTTPS,
        certificates: [props.certificate],
        // TLS 1.2 as the floor (the ELBSecurityPolicy-TLS13-1-2-2021-06 policy). The older
        // `RECOMMENDED` policy still negotiates TLS 1.0/1.1, which is not acceptable for an endpoint
        // that will soon carry bearer tokens.
        sslPolicy: SslPolicy.RECOMMENDED_TLS,
        defaultTargetGroups: [this.targetGroup],
        open: false,
      });
    }

    // The Phase 1 load balancer security group already accepts HTTPS on 443; port 80 is opened here
    // because Phase 2 added the HTTP listener. With a certificate, port 80 is still needed: it is
    // where the redirect to HTTPS answers. These are the only CIDR-based inbound rules in the
    // application stack.
    albSecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(LISTENER_PORT), 'HTTP from the internet');

    this.service = this.createService(cluster, applicationSecurityGroup, serviceName, config);
  }

  /**
   * The task execution role. ECS assumes it, not the application, to perform the infrastructure
   * actions it needs before the container even starts: pulling the image from ECR, creating the
   * CloudWatch log stream and reading the database credentials out of Secrets Manager to inject
   * them into the container. Every grant is scoped to the specific repository, log group and
   * secret, so the role has no wildcard resource and no managed policy.
   *
   * Reading the secret belongs here rather than on the task role: the value is fetched by the ECS
   * agent during startup, so the running application never holds a credential it could leak.
   */
  private createExecutionRole(repository: IRepository, database: DatabaseConnection): Role {
    const role = new Role(this, 'TaskExecutionRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'ECS task execution role: pull the image, write container logs, read the DB secret',
    });

    repository.grantPull(role);
    this.logGroup.grantWrite(role);
    // Grants secretsmanager:GetSecretValue and DescribeSecret on this one secret. No KMS statement
    // is added because the secret is encrypted with the AWS managed key, so there is nothing extra
    // to grant.
    database.secret.grantRead(role);

    return role;
  }

  /**
   * The task role, assumed by the application code itself. The application talks to PostgreSQL over
   * JDBC and to nothing else - it does not call a single AWS API - so the role carries no
   * permissions at all: a compromised container has no AWS credentials worth using. The database
   * password reaches the container through the execution role instead, which never runs application
   * code.
   */
  private createTaskRole(): Role {
    return new Role(this, 'TaskRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Application task role: no AWS permissions (the API only speaks SQL)',
    });
  }

  private createTaskDefinition(
    serviceName: string,
    repository: IRepository,
    config: ApplicationConfig,
    database: DatabaseConnection,
  ): FargateTaskDefinition {
    const taskDefinition = new FargateTaskDefinition(this, 'TaskDefinition', {
      family: `${serviceName}-task`,
      cpu: config.cpu,
      memoryLimitMiB: config.memoryLimitMiB,
      executionRole: this.executionRole,
      taskRole: this.taskRole,
    });

    taskDefinition.addContainer('Api', {
      containerName: 'api',
      image: ContainerImage.fromEcrRepository(repository, config.imageTag),
      logging: LogDrivers.awsLogs({ streamPrefix: 'api', logGroup: this.logGroup }),
      portMappings: [{ containerPort: config.containerPort, protocol: EcsProtocol.TCP }],
      // SERVER_PORT makes the container listen on the same port the target group and task definition
      // use, so changing the port in configuration changes it in all three places at once.
      environment: {
        SERVER_PORT: String(config.containerPort),
        // Connection details are configuration, not credentials, so they are plain variables.
        DB_HOST: database.host,
        DB_PORT: database.port,
        DB_NAME: database.databaseName,
      },
      // Credentials are injected by the ECS agent from Secrets Manager as the container starts and
      // are never visible in the task definition, the console or the image. Spring Boot reads them
      // as ordinary environment variables (see application.properties).
      secrets: {
        DB_USERNAME: EcsSecret.fromSecretsManager(database.secret, 'username'),
        DB_PASSWORD: EcsSecret.fromSecretsManager(database.secret, 'password'),
      },
      essential: true,
    });

    return taskDefinition;
  }

  private createService(
    cluster: Cluster,
    applicationSecurityGroup: ISecurityGroup,
    serviceName: string,
    config: ApplicationConfig,
  ): FargateService {
    const service = new FargateService(this, 'Service', {
      serviceName,
      cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: config.desiredCount,
      securityGroups: [applicationSecurityGroup],
      // Private subnets only: the task has no route to the internet gateway and no public address.
      // Outbound image pulls and patches go through the NAT gateway.
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      // Roll the deployment back automatically if the new task never becomes healthy, instead of
      // leaving a half-deployed service behind.
      circuitBreaker: { rollback: true },
      // Spring Boot needs a few seconds to start before the ALB health check can pass.
      healthCheckGracePeriod: Duration.seconds(60),
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      // Propagate the stack tags onto the running tasks themselves, so a task - and the cost and log
      // records it produces - can be traced back to its environment and project.
      enableECSManagedTags: true,
      propagateTags: PropagatedTagSource.SERVICE,
    });

    // Registers the service with the target group and, because the ALB health check depends on it,
    // keeps the task's IP registration in sync with the ECS scheduler.
    service.attachToApplicationTargetGroup(this.targetGroup);

    return service;
  }
}
