import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { ISecurityGroup, IVpc, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { IRepository } from 'aws-cdk-lib/aws-ecr';
import { Cluster } from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

import { EnvironmentConfig } from '../config/types';
import { LoadBalancedApi } from '../constructs/load-balanced-api';
import { applyPlatformTags } from '../tags';

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
}

/**
 * Phase 2 application compute for the e-commerce platform.
 *
 * Creates the ECS cluster and - through {@link LoadBalancedApi} - the Fargate task definition, the
 * ECS service and the internet-facing Application Load Balancer that fronts it. It consumes the
 * Phase 1 network and the Phase 2 registry by reference rather than redefining them, so the VPC,
 * subnets, security groups and repository remain defined in exactly one place.
 *
 * No database, cache, queue or auto scaling is created here: the API serves in-memory data and the
 * service runs a single task, both deliberate constraints of this phase.
 */
export class ApplicationStack extends Stack {
  /** The ECS cluster the service runs in. */
  public readonly cluster: Cluster;

  /** The load balanced API: task definition, service, target group, listener and load balancer. */
  public readonly api: LoadBalancedApi;

  constructor(scope: Construct, id: string, props: ApplicationStackProps) {
    super(scope, id, props);

    const { config, vpc, repository } = props;
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
      removalPolicy: config.removalPolicy,
    });

    applyPlatformTags(this, config);
    this.createOutputs(config, serviceName);
  }

  /**
   * Publishes where the API answers and how to find the ECS resources. Export names are environment
   * specific so dev, uat and prod coexist in one account.
   */
  private createOutputs(config: EnvironmentConfig, serviceName: string): void {
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
      value: `http://${this.api.loadBalancer.loadBalancerDnsName}`,
      description: 'Public HTTP endpoint of the API',
      exportName: `${exportPrefix}-api-url`,
    });

    new CfnOutput(this, 'TargetGroupArn', {
      value: this.api.targetGroup.targetGroupArn,
      description: `Target group the ECS service ${serviceName} registers with`,
      exportName: `${exportPrefix}-target-group-arn`,
    });
  }
}
