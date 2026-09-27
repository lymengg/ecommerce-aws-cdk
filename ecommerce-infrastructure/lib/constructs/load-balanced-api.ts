import { Duration, RemovalPolicy } from 'aws-cdk-lib';
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
} from 'aws-cdk-lib/aws-ecs';
import {
  ApplicationListener,
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  Protocol as ElbProtocol,
  TargetType,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

import { ApplicationConfig } from '../config/types';

/** Port the load balancer accepts public HTTP traffic on. HTTPS is added in a later phase. */
const LISTENER_PORT = 80;

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

  /** Removal policy for resources that support one: the log group. */
  readonly removalPolicy: RemovalPolicy;
}

/**
 * The Phase 2 application tier: a Spring Boot API running as a single Fargate task behind an
 * internet-facing Application Load Balancer.
 *
 *   Internet -> ALB (public subnets) -> target group -> ECS service (private subnets) -> Fargate task
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

  /** HTTP listener that forwards to {@link targetGroup}. */
  public readonly listener: ApplicationListener;

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

    const { vpc, cluster, repository, config, serviceName, albSecurityGroup, applicationSecurityGroup } = props;

    this.logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/${serviceName}`,
      retention: config.logRetention,
      removalPolicy: props.removalPolicy,
    });

    this.executionRole = this.createExecutionRole(repository);
    this.taskRole = this.createTaskRole();
    this.taskDefinition = this.createTaskDefinition(serviceName, repository, config);

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

    // `open: false` keeps the listener from quietly adding a 0.0.0.0/0 rule; the ingress rule below
    // is added explicitly instead, so the one public entry point is visible in the template.
    this.listener = this.loadBalancer.addListener('HttpListener', {
      port: LISTENER_PORT,
      protocol: ApplicationProtocol.HTTP,
      defaultTargetGroups: [this.targetGroup],
      open: false,
    });

    // The Phase 1 load balancer security group only accepts HTTPS. The Phase 2 listener speaks plain
    // HTTP, so port 80 is opened here. This is the single CIDR-based inbound rule in Phase 2.
    albSecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(LISTENER_PORT), 'HTTP from the internet');

    this.service = this.createService(cluster, applicationSecurityGroup, serviceName, config);
  }

  /**
   * The task execution role. ECS assumes it, not the application, to perform the two infrastructure
   * actions it needs before the container even starts: pulling the image from ECR and creating the
   * CloudWatch log stream. Both grants are scoped to the specific repository and log group, so the
   * role has no wildcard resource and no managed policy.
   */
  private createExecutionRole(repository: IRepository): Role {
    const role = new Role(this, 'TaskExecutionRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'ECS task execution role: pull the image from ECR and write container logs',
    });

    repository.grantPull(role);
    this.logGroup.grantWrite(role);

    return role;
  }

  /**
   * The task role, assumed by the application code itself. Phase 2 has no database, queue or bucket,
   * so it carries no permissions at all: a compromised container has no AWS credentials worth using.
   * It exists now so later phases attach permissions to a role that is already wired into the task.
   */
  private createTaskRole(): Role {
    return new Role(this, 'TaskRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Application task role: no AWS permissions in Phase 2 (in-memory data only)',
    });
  }

  private createTaskDefinition(
    serviceName: string,
    repository: IRepository,
    config: ApplicationConfig,
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
      environment: { SERVER_PORT: String(config.containerPort) },
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
