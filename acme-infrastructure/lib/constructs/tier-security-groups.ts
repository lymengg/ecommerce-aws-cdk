import { ISecurityGroup, IVpc, Peer, Port, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/** Port the application tier listens on behind the shared load balancer. */
export const APPLICATION_PORT = 8080;

/** Port the database tier listens on (RDS PostgreSQL). */
export const DATABASE_PORT = 5432;

export interface TierSecurityGroupsProps {
  readonly vpc: IVpc;

  /**
   * The shared ingress ALB's security group, owned by the platform's ingress stack and passed in
   * by reference. It is the only group allowed to reach the application tier: every service's
   * tasks accept traffic from the shared load balancer and from nothing else.
   */
  readonly albSecurityGroup: ISecurityGroup;
}

/**
 * Security groups for the service's request flow:
 *
 *   Internet -> shared ALB (platform) -> Application (private subnets) -> Database (isolated)
 *
 * Only the platform-owned load balancer group may reach the application tier; the database tier
 * accepts traffic only from this service's application group, so another service in the same
 * subnets cannot reach it. The database tier accepts no traffic from `0.0.0.0/0` under any
 * circumstance.
 *
 * Outbound traffic is denied by default (`allowAllOutbound: false`) and then granted explicitly.
 * Only the two well known tier ports are opened here; the resources themselves and any additional
 * ports are added in later phases, which keeps the rules minimal and reviewable.
 */
export class TierSecurityGroups extends Construct {
  /** Attached to the ECS/Fargate tasks. */
  public readonly application: SecurityGroup;

  /** Attached to the RDS and ElastiCache resources. */
  public readonly database: SecurityGroup;

  constructor(scope: Construct, id: string, props: TierSecurityGroupsProps) {
    super(scope, id);

    const { vpc, albSecurityGroup } = props;

    this.application = new SecurityGroup(this, 'Application', {
      vpc,
      description: 'Application tier, private subnets only',
      allowAllOutbound: false,
    });

    this.database = new SecurityGroup(this, 'Database', {
      vpc,
      description: 'Database tier, private subnets only',
      allowAllOutbound: false,
    });

    // Shared ALB -> application, by security group reference. The matching egress lives on the
    // platform's ingress security group (scoped to the VPC CIDR on the backend port); only this
    // service's acceptance of the traffic belongs to the service.
    this.application.addIngressRule(albSecurityGroup, Port.tcp(APPLICATION_PORT), 'Traffic from the shared load balancer');

    // Application -> database, by security group reference.
    this.application.addEgressRule(this.database, Port.tcp(DATABASE_PORT), 'Database access');
    this.database.addIngressRule(this.application, Port.tcp(DATABASE_PORT), 'Traffic from the application tier');

    // Outbound internet access for the application tier, through the NAT Gateway. Needed for
    // container image pulls and patching. Restricted to TLS; anything AWS-specific should use a VPC
    // endpoint in a later phase instead of traversing the NAT Gateway.
    this.application.addEgressRule(Peer.anyIpv4(), Port.tcp(443), 'Outbound HTTPS through the NAT Gateway');
  }
}
