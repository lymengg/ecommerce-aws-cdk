import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { ISecurityGroup, IVpc, SubnetType } from 'aws-cdk-lib/aws-ec2';
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
  ApplicationListenerRule,
  ApplicationProtocol,
  ApplicationTargetGroup,
  IApplicationListener,
  ListenerAction,
  ListenerCondition,
  Protocol as ElbProtocol,
  TargetType,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

import { ApplicationConfig } from '../config/types';

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

/**
 * Everything the container needs to authenticate as the OAuth client of the Cognito user pool
 * (Phase 4).
 *
 * The issuer URL, the client id, the frontend URL, the CORS allowlist and the session timeout are
 * configuration, not secrets, so they travel as ordinary environment variables. Only the client
 * secret comes from Secrets Manager, injected by ECS at container start exactly like the database
 * password. Nothing here ever reaches the browser: the browser only holds an `httpOnly` session
 * cookie, which is the whole point of the Backend for Frontend pattern.
 */
export interface AuthConnection {
  /** OIDC issuer URL of the user pool, used for discovery and token signature validation. */
  readonly issuerUrl: string;

  /** Public identifier of the confidential app client. Not a secret. */
  readonly userPoolClientId: string;

  /** Secret holding the app client secret under the `clientSecret` key. */
  readonly clientSecret: ISecret;

  /** The SPA's URL: the OAuth2 login-success and post-logout landing, and a registered logout URI. */
  readonly frontendUrl: string;

  /**
   * Exact frontend origins allowed to call the API with credentials. Never a wildcard: the API
   * answers with `Access-Control-Allow-Credentials: true`.
   */
  readonly allowedOrigins: readonly string[];

  /** How long the BFF keeps its server-side session, applied to the session cookie. */
  readonly sessionTimeout: Duration;
}

export interface LoadBalancedApiProps {
  /** The Phase 1 VPC. The target group lives in it, the tasks in its private subnets. */
  readonly vpc: IVpc;

  /**
   * The shared ingress HTTPS listener, imported by reference. The host rule routing
   * {@link hostName} to this service's target group is attached to it; the rule is created as a
   * resource of *this* stack, because a listener rule construct's template follows the scope it is
   * declared in, not the listener's.
   */
  readonly listener: IApplicationListener;

  /**
   * Host header the listener rule matches, for example `api.dev.example.com`. Omitted only when the
   * environment has no delegated domain; without one no rule is created, so unmatched traffic keeps
   * answering the shared listener's 404 rather than this target group.
   */
  readonly hostName?: string;

  /** Listener rule priority, allocated from this service's {@link INGRESS_PRIORITIES} block. */
  readonly priority: number;

  /** ECS cluster the service is created in. */
  readonly cluster: Cluster;

  /** ECR repository the container image is pulled from. */
  readonly repository: IRepository;

  /** Application tier configuration: sizing, port, health check path, image tag. */
  readonly config: ApplicationConfig;

  /** Name shared by the ECS service, task family, load balancer, target group and log group. */
  readonly serviceName: string;

  /** The application security group. The ECS tasks carry it, so the shared ALB can reach them. */
  readonly applicationSecurityGroup: ISecurityGroup;

  /** Where the container finds the database and the secret holding its credentials (Phase 3). */
  readonly database: DatabaseConnection;

  /** How the container authenticates as the Cognito OAuth client (Phase 4). */
  readonly auth: AuthConnection;

  /** Removal policy for resources that support one: the log group. */
  readonly removalPolicy: RemovalPolicy;
}

/**
 * The application tier: a Spring Boot API running as Fargate tasks behind the platform's shared
 * Application Load Balancer, reading and writing PostgreSQL (Phase 3).
 *
 *   Internet -> shared ALB :443 -host rule-> target group -> ECS service (private) -> Fargate task
 *                                                                                   |
 *                                                                TCP 5432 (application SG)
 *                                                                                   v
 *                                                                     RDS (isolated subnets)
 *
 * The shared load balancer - owned by the platform's ingress stack - is the only internet-facing
 * resource; the task itself has no public address and is reachable only from the load balancer's
 * security group. What this construct owns is everything *behind* the shared listener: the target
 * group, the host rule that routes this service's host name to it, and the compute. The ECS
 * service registers and deregisters its tasks with the target group automatically, so no task IP
 * address is ever managed by hand.
 */
export class LoadBalancedApi extends Construct {
  /** Target group the ECS service registers its tasks with. */
  public readonly targetGroup: ApplicationTargetGroup;

  /** The host rule on the shared listener routing {@link LoadBalancedApiProps.hostName} here. */
  public readonly listenerRule?: ApplicationListenerRule;

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

    const {
      vpc,
      listener,
      hostName,
      priority,
      cluster,
      repository,
      config,
      serviceName,
      applicationSecurityGroup,
      database,
      auth,
    } = props;

    this.logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/${serviceName}`,
      retention: config.logRetention,
      removalPolicy: props.removalPolicy,
    });

    this.executionRole = this.createExecutionRole(repository, database, auth);
    this.taskRole = this.createTaskRole();
    this.taskDefinition = this.createTaskDefinition(serviceName, repository, config, database, auth);

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

    // The rule, not the listener, is the service's contribution to the shared load balancer. Only
    // this service's host matches; every other host falls through to another service's rule or to
    // the listener's fixed 404 default. With no host name no rule exists at all - a fabricated host
    // would be a quiet hole in the shared listener's "unmatched means 404" contract.
    if (hostName !== undefined) {
      this.listenerRule = new ApplicationListenerRule(this, 'HostRule', {
        listener,
        priority,
        conditions: [ListenerCondition.hostHeaders([hostName])],
        action: ListenerAction.forward([this.targetGroup]),
      });
    }

    this.service = this.createService(cluster, applicationSecurityGroup, serviceName, config);
  }

  /**
   * The task execution role. ECS assumes it, not the application, to perform the infrastructure
   * actions it needs before the container even starts: pulling the image from ECR, creating the
   * CloudWatch log stream and reading the database and Cognito client secrets out of Secrets
   * Manager to inject them into the container. Every grant is scoped to the specific repository,
   * log group and secret, so the role has no wildcard resource and no managed policy.
   *
   * Reading the secrets belongs here rather than on the task role: the values are fetched by the
   * ECS agent during startup, so the running application never holds a credential it could leak.
   * The Cognito client secret is the one new grant Phase 4 adds - nothing else in IAM changes.
   */
  private createExecutionRole(repository: IRepository, database: DatabaseConnection, auth: AuthConnection): Role {
    const role = new Role(this, 'TaskExecutionRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'ECS task execution role: pull the image, write container logs, read the DB and Cognito secrets',
    });

    repository.grantPull(role);
    this.logGroup.grantWrite(role);
    // Grants secretsmanager:GetSecretValue and DescribeSecret on this one secret. No KMS statement
    // is added because the secret is encrypted with the AWS managed key, so there is nothing extra
    // to grant.
    database.secret.grantRead(role);
    // The Cognito app client secret, injected as COGNITO_CLIENT_SECRET. Scoped to that one secret.
    auth.clientSecret.grantRead(role);

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
    auth: AuthConnection,
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
        // Phase 4 auth wiring. The issuer, client id and logout URI are public identifiers; the
        // CORS allowlist is an explicit set of origins (never `*`); the session timeout is the BFF
        // session cookie's lifetime.
        COGNITO_ISSUER_URI: auth.issuerUrl,
        COGNITO_CLIENT_ID: auth.userPoolClientId,
        FRONTEND_URL: auth.frontendUrl,
        CORS_ALLOWED_ORIGINS: auth.allowedOrigins.join(','),
        SESSION_TIMEOUT: auth.sessionTimeout.toIsoString(),
      },
      // Credentials are injected by the ECS agent from Secrets Manager as the container starts and
      // are never visible in the task definition, the console or the image. Spring Boot reads them
      // as ordinary environment variables (see application.properties). The Cognito client secret
      // follows exactly the same path as the database password.
      secrets: {
        DB_USERNAME: EcsSecret.fromSecretsManager(database.secret, 'username'),
        DB_PASSWORD: EcsSecret.fromSecretsManager(database.secret, 'password'),
        COGNITO_CLIENT_SECRET: EcsSecret.fromSecretsManager(auth.clientSecret, 'clientSecret'),
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
