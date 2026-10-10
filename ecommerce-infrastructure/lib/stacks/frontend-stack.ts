import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import { ISecurityGroup, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Cluster, ContainerImage, FargateService, FargateTaskDefinition, LogDrivers, Protocol as EcsProtocol, PropagatedTagSource } from 'aws-cdk-lib/aws-ecs';
import { IRepository, Repository } from 'aws-cdk-lib/aws-ecr';
import {
  ApplicationListener,
  ApplicationListenerRule,
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  ListenerAction,
  ListenerCondition,
  Protocol as ElbProtocol,
  TargetType,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { ARecord, AaaaRecord, IHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

import { EnvironmentConfig, FrontendConfig } from '../config/types';
import { FRONTEND_REPOSITORY_NAME, RegistryLocation } from './ecr-stack';
import { applyPlatformTags } from '../tags';

/** Priority of the host rule that sends the SPA's host to this service. */
const HOST_RULE_PRIORITY = 10;

/** nginx is serving files; it is listening within a second of the container starting. */
const HEALTH_CHECK_GRACE_PERIOD = Duration.seconds(30);

export interface FrontendStackProps extends StackProps {
  /** Environment specific configuration. No environment value is hardcoded in this stack. */
  readonly config: EnvironmentConfig;

  /**
   * Where the shared registry lives. The frontend image (`ecommerce-frontend`) is pulled from the
   * registry account, which may differ from this stack's - the repository is imported by ARN for
   * the same reason as the application's: a construct reference cannot cross a stage boundary.
   */
  readonly registry: RegistryLocation;

  /** The ECS cluster the application tier runs in. The frontend joins it rather than adding one. */
  readonly cluster: Cluster;

  /**
   * The Phase 1 application security group. The load balancer already reaches it on the container
   * port (that rule belongs to the application tier), so attaching this group is the whole of the
   * frontend's network wiring - **no new security group rule is added**.
   */
  readonly applicationSecurityGroup: ISecurityGroup;

  /** The Phase 2 load balancer, consumed by reference, for the apex alias records. */
  readonly loadBalancer: ApplicationLoadBalancer;

  /**
   * The load balancer's security group. Only needed so the re-imported listener below has a
   * `connections` object; the group itself is unchanged.
   */
  readonly albSecurityGroup: ISecurityGroup;

  /** The HTTPS listener, consumed by reference, for the host rule. */
  readonly httpsListener: ApplicationListener;

  /** The hosted zone the apex records are created in, consumed from the DNS stack by reference. */
  readonly zone: IHostedZone;
}

/**
 * Phase 4.5 static frontend: the Nuxt storefront, served by nginx as a second Fargate service behind
 * the existing load balancer.
 *
 * ```
 *   browser ──HTTPS──▶ ALB :443 ──host: <env-domain>────▶ frontend TG ──8080──▶ nginx (SPA)
 *                        │
 *                        └────────host: api.<env-domain>▶ api TG ──8080──▶ Spring Boot
 * ```
 *
 * The SPA answers on the **apex** of the delegated subdomain and the API on `api.`, so the two are
 * same-site: the BFF's `SameSite=Lax` session cookie is sent on the SPA's API calls, and CORS covers
 * the cross-origin part. That is the whole reason the frontend is hosted on the platform's own
 * domain rather than on a third-party static host.
 *
 * Why nginx rather than a CDN: the static bundle has to be reachable over HTTPS on a name that is
 * same-site with the API. A CloudFront distribution would do it, but this account cannot create
 * CloudFront resources until AWS Support verifies it - so the files are served from a container
 * behind the load balancer that already exists. When the account is verified, CloudFront becomes a
 * CDN **in front of this same service** (Phase 6), which needs no change here.
 *
 * The service is **stateless** - nginx holds nothing between requests - so unlike the API tier it may
 * run more than one task; production runs two.
 */
export class FrontendStack extends Stack {
  /** The ECS service serving the SPA. */
  public readonly service: FargateService;

  /** Target group the service registers with, and the host rule forwards to. */
  public readonly targetGroup: ApplicationTargetGroup;

  /** CloudWatch log group the nginx access and error logs go to. */
  public readonly logGroup: LogGroup;

  /** The SPA's public URL. */
  public readonly siteUrl: string;

  /** The frontend tier configuration, kept for the private factory methods below. */
  private readonly frontendConfig: FrontendConfig;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const { config, cluster, applicationSecurityGroup, loadBalancer, albSecurityGroup, httpsListener, zone } = props;
    // The repository is imported by ARN, like the API's: it lives in the shared registry stage
    // (possibly another account), which deploys - and the pipeline pushes into - before this stack.
    const repository = Repository.fromRepositoryAttributes(this, 'FrontendRepository', {
      repositoryName: FRONTEND_REPOSITORY_NAME,
      repositoryArn: this.formatArn({
        service: 'ecr',
        region: props.registry.region,
        account: props.registry.account,
        resource: 'repository',
        resourceName: FRONTEND_REPOSITORY_NAME,
      }),
    });
    const { dns, frontend } = config;
    const namePrefix = `ecommerce-${config.environment}`;

    this.frontendConfig = frontend;

    if (dns === undefined) {
      throw new Error(`FrontendStack requires config.dns to be set for environment "${config.environment}".`);
    }

    const serviceName = `${namePrefix}-frontend`;
    const siteDomain = dns.zoneName;
    const apiOrigin = `https://${dns.apiSubdomain}.${dns.zoneName}`;

    this.logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/${serviceName}`,
      retention: frontend.logRetention,
      removalPolicy: config.removalPolicy,
    });

    const executionRole = this.createExecutionRole(repository);
    const taskRole = this.createTaskRole();
    const taskDefinition = this.createTaskDefinition(serviceName, repository, apiOrigin, executionRole, taskRole);

    this.targetGroup = new ApplicationTargetGroup(this, 'TargetGroup', {
      targetGroupName: `${serviceName}-tg`,
      vpc: cluster.vpc,
      port: frontend.containerPort,
      protocol: ApplicationProtocol.HTTP,
      // Fargate tasks use awsvpc networking, so targets are addressed by IP, never by instance id.
      targetType: TargetType.IP,
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        path: frontend.healthCheckPath,
        protocol: ElbProtocol.HTTP,
        healthyHttpCodes: '200',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // The listener is re-imported rather than used directly: CDK creates an added rule as a child of
    // the listener construct, so using the application stack's listener would place this rule in the
    // application stack's template. Re-importing creates a listener construct owned by *this* stack,
    // which is where the rule belongs. Same reasoning as the security group in ApplicationStack.
    const listener = ApplicationListener.fromApplicationListenerAttributes(this, 'HttpsListener', {
      listenerArn: httpsListener.listenerArn,
      securityGroup: albSecurityGroup,
    });

    new ApplicationListenerRule(this, 'HostRule', {
      listener,
      priority: HOST_RULE_PRIORITY,
      // Only the SPA's own host is matched. Every other host - including api.<env-domain> and the
      // load balancer's own name - falls through to the listener's default action, which is the API.
      conditions: [ListenerCondition.hostHeaders([siteDomain])],
      action: ListenerAction.forward([this.targetGroup]),
    });

    this.service = this.createService(serviceName, cluster, applicationSecurityGroup, taskDefinition);

    // Alias records, never CNAMEs: an alias is free, follows the load balancer's addresses, and is
    // the only thing that can be created at the zone apex.
    const recordTarget = RecordTarget.fromAlias(new LoadBalancerTarget(loadBalancer));
    new ARecord(this, 'SiteRecord', { zone, target: recordTarget });
    new AaaaRecord(this, 'SiteRecordIpv6', { zone, target: recordTarget });

    this.siteUrl = `https://${siteDomain}`;

    applyPlatformTags(this, config);
    this.createOutputs(config, serviceName);
  }

  /**
   * The task execution role: pull the image from the one frontend repository and write to the one
   * log group. Nothing else - there is no secret to read and no other service to call.
   */
  private createExecutionRole(repository: IRepository): Role {
    const role = new Role(this, 'TaskExecutionRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Frontend task execution role: pull the image and write container logs',
    });

    repository.grantPull(role);
    this.logGroup.grantWrite(role);

    return role;
  }

  /**
   * The task role, assumed by the container. nginx serves files and calls no AWS API, so the role
   * carries no permissions at all - the same posture as the application tier.
   */
  private createTaskRole(): Role {
    return new Role(this, 'TaskRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Frontend task role: no AWS permissions (nginx serves static files)',
    });
  }

  private createTaskDefinition(
    serviceName: string,
    repository: IRepository,
    apiOrigin: string,
    executionRole: Role,
    taskRole: Role,
  ): FargateTaskDefinition {
    const frontend = this.frontendConfig;
    const taskDefinition = new FargateTaskDefinition(this, 'TaskDefinition', {
      family: `${serviceName}-task`,
      cpu: frontend.cpu,
      memoryLimitMiB: frontend.memoryLimitMiB,
      executionRole,
      taskRole,
    });

    taskDefinition.addContainer('Frontend', {
      containerName: 'frontend',
      image: ContainerImage.fromEcrRepository(repository, frontend.imageTag),
      logging: LogDrivers.awsLogs({ streamPrefix: 'frontend', logGroup: this.logGroup }),
      portMappings: [{ containerPort: frontend.containerPort, protocol: EcsProtocol.TCP }],
      // The image's nginx config is an envsubst template; this is the only value it needs. It becomes
      // the Content-Security-Policy's connect-src, so the browser is allowed to call the API and
      // nothing else.
      environment: { API_ORIGIN: apiOrigin },
      essential: true,
    });

    return taskDefinition;
  }

  private createService(
    serviceName: string,
    cluster: Cluster,
    applicationSecurityGroup: ISecurityGroup,
    taskDefinition: FargateTaskDefinition,
  ): FargateService {
    const frontend = this.frontendConfig;
    const service = new FargateService(this, 'Service', {
      serviceName,
      cluster,
      taskDefinition,
      desiredCount: frontend.desiredCount,
      securityGroups: [applicationSecurityGroup],
      // Private subnets only, no public address: outbound image pulls go through the NAT gateway.
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: HEALTH_CHECK_GRACE_PERIOD,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      enableECSManagedTags: true,
      propagateTags: PropagatedTagSource.SERVICE,
    });

    service.attachToApplicationTargetGroup(this.targetGroup);

    return service;
  }

  /** Publishes the SPA's URL and the ECS resources. Export names are environment specific. */
  private createOutputs(config: EnvironmentConfig, serviceName: string): void {
    const exportPrefix = `ecommerce-${config.environment}`;

    new CfnOutput(this, 'SiteUrl', {
      value: this.siteUrl,
      description: 'Public HTTPS URL of the storefront',
      exportName: `${exportPrefix}-frontend-url`,
    });

    new CfnOutput(this, 'ServiceName', {
      value: this.service.serviceName,
      description: `Name of the frontend ECS service ${serviceName}`,
      exportName: `${exportPrefix}-frontend-service-name`,
    });

    new CfnOutput(this, 'TargetGroupArn', {
      value: this.targetGroup.targetGroupArn,
      description: 'Target group the frontend ECS service registers with',
      exportName: `${exportPrefix}-frontend-target-group-arn`,
    });
  }
}
