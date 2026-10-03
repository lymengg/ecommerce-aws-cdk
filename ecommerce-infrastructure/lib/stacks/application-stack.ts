import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { ISecurityGroup, IVpc, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { IRepository } from 'aws-cdk-lib/aws-ecr';
import { Cluster } from 'aws-cdk-lib/aws-ecs';
import { ARecord, IHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

import { EnvironmentConfig } from '../config/types';
import { DatabaseConnection, LoadBalancedApi } from '../constructs/load-balanced-api';
import { applyPlatformTags } from '../tags';

/**
 * Phase 3.5 DNS/TLS wiring, consumed from the DNS stack by reference. Present only when the
 * environment has a delegated subdomain; without it the stack builds today's HTTP-only endpoint.
 */
export interface ApplicationDnsProps {
  /** The hosted zone the API record is created in. */
  readonly zone: IHostedZone;

  /** ACM certificate covering {@link domainName}, terminating TLS on the load balancer. */
  readonly certificate: ICertificate;

  /** Fully qualified domain name the API answers on, for example `api.dev.example.com`. */
  readonly domainName: string;
}

export interface ApplicationStackProps extends StackProps {
  /** Environment specific configuration. No environment value is hardcoded in this stack. */
  readonly config: EnvironmentConfig;

  /** The Phase 1 VPC. */
  readonly vpc: IVpc;

  /** The container registry created by the ECR stack, which must be deployed first. */
  readonly repository: IRepository;

  /** The Phase 1 load balancer security group, whose HTTP rule is added by this stack. */
  readonly albSecurityGroup: ISecurityGroup;

  /** The Phase 1 application security group, carried by the ECS tasks. */
  readonly applicationSecurityGroup: ISecurityGroup;

  /**
   * Where the database is and how to authenticate against it. Read from the Phase 3 database stack
   * so this stack never defines a database resource itself.
   */
  readonly database: DatabaseConnection;

  /**
   * Phase 3.5 DNS and TLS, read from the DNS stack by reference. Omitted in dev until a subdomain
   * has been delegated, which keeps the HTTP-only path working.
   */
  readonly dns?: ApplicationDnsProps;
}

/**
 * Phase 2 application compute for the e-commerce platform, wired to the Phase 3 database.
 *
 * Creates the ECS cluster and - through {@link LoadBalancedApi} - the Fargate task definition, the
 * ECS service and the internet-facing Application Load Balancer that fronts it. It consumes the
 * Phase 1 network, the Phase 2 registry and the Phase 3 database by reference rather than
 * redefining them, so the VPC, subnets, security groups, repository and instance remain defined in
 * exactly one place.
 *
 * The database connection details travel as environment variables and the credentials are injected
 * from Secrets Manager by the ECS agent, so this stack - like every other - contains no credential.
 *
 * Phase 3.5 optionally points the API at a name: when a DNS/TLS block is supplied the load balancer
 * gets an HTTPS listener and a port 80 redirect, and an alias record is created in the DNS stack's
 * hosted zone. Both are consumed by reference, so this stack still defines neither the zone nor the
 * certificate.
 *
 * No cache, queue or auto scaling is created here: those are later phases.
 */
export class ApplicationStack extends Stack {
  /** The ECS cluster the service runs in. */
  public readonly cluster: Cluster;

  /** The load balanced API: task definition, service, target group, listener and load balancer. */
  public readonly api: LoadBalancedApi;

  constructor(scope: Construct, id: string, props: ApplicationStackProps) {
    super(scope, id, props);

    const { config, vpc, repository, database } = props;
    const namePrefix = `ecommerce-${config.environment}`;
    const serviceName = `${namePrefix}-api`;

    this.cluster = new Cluster(this, 'Cluster', {
      clusterName: `${namePrefix}-cluster`,
      vpc,
    });

    // The Phase 1 load balancer security group is re-imported by id rather than used directly. CDK
    // creates an added ingress rule as a child of the security group construct, so using the Phase 1
    // construct would place the Phase 2 HTTP rule in the network stack's template. Re-importing
    // creates a security group construct owned by this stack, which is where the rule belongs.
    const albSecurityGroup = SecurityGroup.fromSecurityGroupId(
      this,
      'AlbSecurityGroup',
      props.albSecurityGroup.securityGroupId,
    );

    this.api = new LoadBalancedApi(this, 'Api', {
      vpc,
      cluster: this.cluster,
      repository,
      config: config.application,
      serviceName,
      albSecurityGroup,
      applicationSecurityGroup: props.applicationSecurityGroup,
      database,
      certificate: props.dns?.certificate,
      domainName: props.dns?.domainName,
      removalPolicy: config.removalPolicy,
    });

    if (props.dns !== undefined) {
      // An alias record, never an IP: the load balancer's address changes without notice, and an
      // alias is free of charge and updated by Route 53 whenever the endpoint changes.
      new ARecord(this, 'ApiRecord', {
        zone: props.dns.zone,
        recordName: props.dns.domainName,
        target: RecordTarget.fromAlias(new LoadBalancerTarget(this.api.loadBalancer)),
        comment: `Alias to the ${namePrefix} application load balancer`,
      });
    }

    applyPlatformTags(this, config);
    this.createOutputs(config, serviceName, props.dns);
  }

  /**
   * Publishes where the API answers and how to find the ECS resources. Export names are environment
   * specific so dev, uat and prod coexist in one account.
   */
  private createOutputs(config: EnvironmentConfig, serviceName: string, dns: ApplicationDnsProps | undefined): void {
    const exportPrefix = `ecommerce-${config.environment}`;

    new CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      description: 'Name of the ECS cluster',
      exportName: `${exportPrefix}-ecs-cluster-name`,
    });

    new CfnOutput(this, 'ServiceName', {
      value: this.api.service.serviceName,
      description: 'Name of the ECS service',
      exportName: `${exportPrefix}-ecs-service-name`,
    });

    new CfnOutput(this, 'LoadBalancerDnsName', {
      value: this.api.loadBalancer.loadBalancerDnsName,
      description: 'DNS name of the application load balancer',
      exportName: `${exportPrefix}-alb-dns-name`,
    });

    new CfnOutput(this, 'ApiUrl', {
      // With a certificate the API is reached by name over TLS; without one it is still the load
      // balancer's own DNS name over plain HTTP, exactly as in Phase 2.
      value: dns === undefined ? `http://${this.api.loadBalancer.loadBalancerDnsName}` : `https://${dns.domainName}`,
      description: dns === undefined ? 'Public HTTP endpoint of the API' : 'Public HTTPS endpoint of the API',
      exportName: `${exportPrefix}-api-url`,
    });

    if (dns !== undefined) {
      // Kept alongside the HTTPS URL because it is what the redirect is verified against: a request
      // to this plain HTTP endpoint must answer 301 with a Location of the HTTPS URL above.
      new CfnOutput(this, 'HttpApiUrl', {
        value: `http://${this.api.loadBalancer.loadBalancerDnsName}`,
        description: 'Plain HTTP endpoint of the load balancer, which redirects to HTTPS',
        exportName: `${exportPrefix}-api-http-url`,
      });
    }

    new CfnOutput(this, 'TargetGroupArn', {
      value: this.api.targetGroup.targetGroupArn,
      description: `Target group the ECS service ${serviceName} registers with`,
      exportName: `${exportPrefix}-target-group-arn`,
    });
  }
}
