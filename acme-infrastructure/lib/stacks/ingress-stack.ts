import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { IVpc, Peer, Port, SecurityGroup, SubnetType } from 'aws-cdk-lib/aws-ec2';
import {
  ApplicationListener,
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ListenerAction,
  SslPolicy,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

import { EnvironmentConfig } from '../config/types';
import { foundationExportName, INGRESS_EXPORTS } from '../foundation-exports';
import { applyPlatformTags } from '../tags';

/** Port every service's tasks listen on behind the shared load balancer. */
const BACKEND_PORT = 8080;

export interface IngressStackProps extends StackProps {
  /** Environment specific configuration. No environment value is hardcoded in this stack. */
  readonly config: EnvironmentConfig;

  /** The shared network foundation's VPC: the ALB lands in its public subnets. */
  readonly vpc: IVpc;

  /** The shared DNS foundation's certificate, the listener's default (SNI) certificate. */
  readonly certificate: ICertificate;
}

/**
 * The shared ingress tier: one internet-facing Application Load Balancer for the whole
 * environment, owned by the platform team.
 *
 *   Internet -> acme-<env>-alb :443 -host rule-> service target group -> service tasks
 *                                 -host rule-> service target group -> service tasks
 *
 * Cost is the reason this exists: an ALB costs a fixed hourly rate whether it fronts one service
 * or twenty, so every service attaching a rule to this one listener is how the environment pays
 * for a single load balancer instead of one per service.
 *
 * The ownership split mirrors the network foundation's:
 *
 *   platform (this stack)          service stacks
 *   ---------------------          --------------------------------------------
 *   the ALB and its listeners      target groups, health checks, ECS services
 *   the shared ALB security group  listener rules (allocated INGRESS_PRIORITIES)
 *   the default :404 action        alias records pointing at the ALB
 *
 * Port 80 only redirects to 443 and port 443's default action answers 404, so a request whose
 * Host header matches no service's rule is turned away at the edge rather than landing on a
 * "default" service - a correctness property of the shared listener, not just a cosmetic one.
 *
 * The listener ARN, ALB attributes and shared security group id are published under the
 * `acme-<env>-*` contract so any service stack - in this repository or another - can attach a
 * rule without ever reading this stack's code.
 */
export class IngressStack extends Stack {
  /** The shared internet-facing load balancer. */
  public readonly loadBalancer: ApplicationLoadBalancer;

  /** The security group the ALB carries: internet-facing on 80/443, VPC-scoped egress. */
  public readonly securityGroup: SecurityGroup;

  /** The HTTPS listener every service attaches its host rules to. */
  public readonly httpsListener: ApplicationListener;

  constructor(scope: Construct, id: string, props: IngressStackProps) {
    super(scope, id, props);

    const { config, vpc, certificate } = props;
    const namePrefix = `acme-${config.environment}`;

    // `open: false` keeps the ALB from adding its own 0.0.0.0/0 rules; the ingress rules below are
    // added explicitly so the public entry points are visible in the template. Egress is scoped to
    // the VPC CIDR on the shared backend port rather than left open: the only thing the ALB should
    // ever reach is a service task.
    this.securityGroup = new SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      securityGroupName: `${namePrefix}-ingress-sg`,
      description: 'Shared ingress ALB: internet in on 80/443, VPC out on the backend port',
      allowAllOutbound: false,
    });
    this.securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(443), 'HTTPS from the internet');
    this.securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(80), 'HTTP from the internet (redirects to 443)');
    this.securityGroup.addEgressRule(Peer.ipv4(config.vpcCidr), Port.tcp(BACKEND_PORT), 'Forward to service tasks in the VPC');

    this.loadBalancer = new ApplicationLoadBalancer(this, 'LoadBalancer', {
      loadBalancerName: `${namePrefix}-alb`,
      vpc,
      internetFacing: true,
      securityGroup: this.securityGroup,
      // Only the public subnets have a route to the internet gateway, which an internet-facing ALB
      // needs in both directions.
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      // Deletion protection follows the environment's removal policy: dev can be torn down, uat and
      // prod cannot lose the endpoint to an accidental `cdk destroy`.
      deletionProtection: config.removalPolicy === RemovalPolicy.RETAIN,
    });

    // Port 80 never forwards: every plaintext request is redirected to 443 before it can reach a
    // service, regardless of which host the request was for.
    this.loadBalancer.addListener('HttpListener', {
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      defaultAction: ListenerAction.redirect({
        port: '443',
        protocol: ApplicationProtocol.HTTPS,
        permanent: true,
      }),
      open: false,
    });

    // The default action is a fixed 404, not a target group: no service may be the implicit catch
    // all, because an unmatched Host must not silently land on whichever service deployed first.
    this.httpsListener = this.loadBalancer.addListener('HttpsListener', {
      port: 443,
      protocol: ApplicationProtocol.HTTPS,
      certificates: [certificate],
      // TLS 1.2 as the floor (the ELBSecurityPolicy-TLS13-1-2-2021-06 policy).
      sslPolicy: SslPolicy.RECOMMENDED_TLS,
      defaultAction: ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'No service matched this host.',
      }),
      open: false,
    });

    // HSTS on the shared listener so every response on 443 - including each service's - carries it.
    this.httpsListener.setAttribute(
      'routing.http.response.strict_transport_security.header_value',
      'max-age=31536000; includeSubDomains',
    );

    applyPlatformTags(this, config);
    this.createExports(config.environment);
  }

  /**
   * Publishes the four facts a service needs to attach to the shared ingress: the listener ARN to
   * hang rules on, the ALB attributes to aim alias records at, and the security group id a
   * service's application group must accept traffic from.
   */
  private createExports(environment: string): void {
    const exportName = (key: string): string => foundationExportName(environment, key);

    new CfnOutput(this, 'LoadBalancerArn', {
      value: this.loadBalancer.loadBalancerArn,
      description: 'ARN of the shared application load balancer',
      exportName: exportName(INGRESS_EXPORTS.loadBalancerArn),
    });
    new CfnOutput(this, 'LoadBalancerDnsName', {
      value: this.loadBalancer.loadBalancerDnsName,
      description: 'DNS name of the shared application load balancer',
      exportName: exportName(INGRESS_EXPORTS.loadBalancerDnsName),
    });
    new CfnOutput(this, 'LoadBalancerCanonicalHostedZoneId', {
      value: this.loadBalancer.loadBalancerCanonicalHostedZoneId,
      description: 'Canonical hosted zone id of the shared ALB (for Route 53 alias targets)',
      exportName: exportName(INGRESS_EXPORTS.loadBalancerCanonicalHostedZoneId),
    });
    new CfnOutput(this, 'AlbSecurityGroupId', {
      value: this.securityGroup.securityGroupId,
      description: 'Security group the shared ALB carries; service app groups accept it on the backend port',
      exportName: exportName(INGRESS_EXPORTS.securityGroupId),
    });
    new CfnOutput(this, 'HttpsListenerArn', {
      value: this.httpsListener.listenerArn,
      description: 'Shared HTTPS listener ARN that services attach host rules to',
      exportName: exportName(INGRESS_EXPORTS.httpsListenerArn),
    });
  }
}
