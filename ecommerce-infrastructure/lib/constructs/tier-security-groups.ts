import { IVpc, Peer, Port, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/** Port the application tier will listen on behind the load balancer (Phase 2: ECS/Fargate). */
export const APPLICATION_PORT = 8080;

/** Port the database tier will listen on (Phase 2: RDS PostgreSQL). */
export const DATABASE_PORT = 5432;

/** A destination that can never be a real peer, used by {@link restrictEgress}. */
const NO_TRAFFIC_CIDR = '255.255.255.255/32';
const NO_TRAFFIC_ICMP_TYPE = 252;
const NO_TRAFFIC_ICMP_CODE = 86;

export interface TierSecurityGroupsProps {
  readonly vpc: IVpc;
}

/**
 * Security groups for the three tier request flow:
 *
 *   Internet -> ALB (public subnets) -> Application (private subnets) -> Database (private subnets)
 *
 * Only the load balancer tier is reachable from the internet. Every other rule is expressed with a
 * security group reference, so a tier can only be reached by the tier directly in front of it and
 * no tier can be reached from an arbitrary CIDR. The database tier accepts no traffic from
 * `0.0.0.0/0` under any circumstance.
 *
 * Outbound traffic is denied by default (`allowAllOutbound: false`) and then granted explicitly.
 * Only the two well known tier ports are opened here; the resources themselves and any additional
 * ports are added in later phases, which keeps the rules minimal and reviewable.
 */
export class TierSecurityGroups extends Construct {
  /** Attached to the (future) internet facing Application Load Balancer. */
  public readonly alb: SecurityGroup;

  /** Attached to the (future) ECS/Fargate tasks. */
  public readonly application: SecurityGroup;

  /** Attached to the (future) RDS and ElastiCache resources. */
  public readonly database: SecurityGroup;

  constructor(scope: Construct, id: string, props: TierSecurityGroupsProps) {
    super(scope, id);

    const { vpc } = props;

    this.alb = new SecurityGroup(this, 'Alb', {
      vpc,
      description: 'Internet facing load balancer tier',
      allowAllOutbound: false,
    });

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

    // The single public entry point. HTTPS only: traffic is never accepted in the clear, so port 80
    // is deliberately not opened. The ALB is the only resource in this stack with a CIDR based rule.
    this.alb.addIngressRule(Peer.anyIpv4(), Port.tcp(443), 'HTTPS from the internet');

    // ALB -> application, by security group reference.
    this.alb.addEgressRule(this.application, Port.tcp(APPLICATION_PORT), 'Forward requests to the application tier');
    this.application.addIngressRule(this.alb, Port.tcp(APPLICATION_PORT), 'Traffic from the load balancer');

    // Application -> database, by security group reference.
    this.application.addEgressRule(this.database, Port.tcp(DATABASE_PORT), 'Database access');
    this.database.addIngressRule(this.application, Port.tcp(DATABASE_PORT), 'Traffic from the application tier');

    // Outbound internet access for the application tier, through the NAT Gateway. Needed for
    // container image pulls and patching. Restricted to TLS; anything AWS-specific should use a VPC
    // endpoint in a later phase instead of traversing the NAT Gateway.
    this.application.addEgressRule(Peer.anyIpv4(), Port.tcp(443), 'Outbound HTTPS through the NAT Gateway');

    // Must stay last: see the comment on restrictEgress() below.
    restrictEgress(this.alb);
  }
}

/**
 * CloudFormation adds an "allow all outbound" rule to every security group that has no *inline*
 * egress rules. A rule whose destination is another security group is rendered as a separate
 * `AWS::EC2::SecurityGroupEgress` resource, so a group that only ever talks to another security
 * group ends up with an empty inline list and silently gets the allow-all rule back - undoing
 * `allowAllOutbound: false`.
 *
 * This marker rule matches no traffic at all (`255.255.255.255` is never a destination, and no ICMP
 * message has type 252 / code 86). It is the same rule CDK itself injects into groups that have no
 * egress rules; adding it explicitly keeps the inline list non-empty, so the load balancer tier can
 * really only reach the application tier.
 *
 * It has to be added after the security group reference egress rules, because CDK removes its own
 * no-traffic marker as soon as a real egress rule is added to the group.
 */
function restrictEgress(group: SecurityGroup): void {
  group.addEgressRule(
    Peer.ipv4(NO_TRAFFIC_CIDR),
    Port.icmpTypeAndCode(NO_TRAFFIC_ICMP_TYPE, NO_TRAFFIC_ICMP_CODE),
    'Disallow all traffic',
  );
}
