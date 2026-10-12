/**
 * The CloudFormation export names that form the platform-to-service contract.
 *
 * `acme-network-<env>` and `acme-dns-<env>` publish them; every service stage (and every future
 * service repository) reads them through `Fn.importValue`. Both sides of the boundary import the
 * names from here, so the contract is one file, not a string duplicated across producer and
 * consumer - renaming an export or fat-fingering a key is a compile error, not a deploy-time
 * surprise.
 *
 * The exported VALUES - vpc-id, subnet ids, hosted zone id - are the only things that must agree;
 * a service in another repository would construct the same names with the same `acme-<env>-<key>`
 * shape.
 */
export const foundationExportName = (environment: string, key: string): string =>
  `acme-${environment}-${key}`;

/** The export keys the network foundation publishes. */
export const NETWORK_EXPORTS = {
  vpcId: 'vpc-id',
  publicSubnetIds: 'public-subnet-ids',
  privateSubnetIds: 'private-subnet-ids',
  databaseSubnetIds: 'database-subnet-ids',
} as const;

/** The export keys the DNS foundation publishes. */
export const DNS_EXPORTS = {
  hostedZoneId: 'hosted-zone-id',
  hostedZoneNameServers: 'hosted-zone-name-servers',
  certificateArn: 'certificate-arn',
  apiDomainName: 'api-domain-name',
} as const;

/**
 * The export keys the shared ingress publishes: the one internet-facing load balancer every
 * service attaches its listener rules to. The ALB *chassis* is platform-owned; each service owns
 * its rules and target groups, exactly like the platform owns the subnets while each service owns
 * its security groups.
 */
export const INGRESS_EXPORTS = {
  loadBalancerArn: 'alb-arn',
  loadBalancerDnsName: 'alb-dns-name',
  loadBalancerCanonicalHostedZoneId: 'alb-canonical-hosted-zone-id',
  securityGroupId: 'alb-security-group-id',
  httpsListenerArn: 'https-listener-arn',
} as const;

/**
 * Listener rule priority ranges, allocated per service so two services can never collide on the
 * shared listener. Each service owns a contiguous block of priorities; this file is the single
 * allocation registry - a new service takes the next free block here, never a number picked
 * locally.
 */
export const INGRESS_PRIORITIES = {
  ecommerceApi: 100,
  ecommerceApex: 110,
} as const;
