import { Fn, Stack, StackProps } from 'aws-cdk-lib';
import { Certificate, ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { IVpc, Vpc } from 'aws-cdk-lib/aws-ec2';
import { HostedZone, IHostedZone } from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

import { EnvironmentConfig } from '../config/types';
import { TierSecurityGroups } from '../constructs/tier-security-groups';
import { DNS_EXPORTS, foundationExportName, NETWORK_EXPORTS } from '../foundation-exports';
import { applyPlatformTags } from '../tags';
import { availabilityZoneTokens } from './network-stack';

export interface EcommerceSecurityStackProps extends StackProps {
  /** Environment specific configuration. No environment value is hardcoded in this stack. */
  readonly config: EnvironmentConfig;
}

/**
 * Everything the service borrows from the platform foundation, and the security groups it owns.
 *
 * This is the attachment point of the service stage: it is the ONLY stack that imports the
 * `acme-<env>-*` exports - the shared VPC (with its subnet lists) and the shared hosted zone and
 * certificate - because imported constructs must live in a stack scope and keeping every import in
 * one place makes the platform dependency explicit instead of scattered across consumers.
 *
 * Security groups are created here rather than in the platform's network stack on purpose: a
 * security group is the service's own rulebook, and sharing the tier groups would let every
 * service in the environment reach every other service's database. The service attaches its own
 * `alb` / `application` / `database` groups to the shared VPC and owns the rules between them.
 */
export class EcommerceSecurityStack extends Stack {
  /** The shared environment VPC, imported by CloudFormation export. */
  public readonly vpc: IVpc;

  /** The service's own tier security groups inside the shared VPC. */
  public readonly securityGroups: TierSecurityGroups;

  /** The shared public hosted zone, imported by CloudFormation export. */
  public readonly zone: IHostedZone;

  /** The shared ACM certificate covering the API domain and the apex. */
  public readonly certificate: ICertificate;

  /** Fully qualified domain name the API answers on, for example `api.dev.example.com`. */
  public readonly apiDomainName: string;

  constructor(scope: Construct, id: string, props: EcommerceSecurityStackProps) {
    super(scope, id, props);

    const { config } = props;
    const { environment, dns } = config;

    if (dns === undefined) {
      throw new Error(`EcommerceSecurityStack requires config.dns for environment "${environment}".`);
    }

    const importValue = (key: string) => Fn.importValue(foundationExportName(environment, key));

    // The subnet lists are exported comma-joined, so each id is selected by index - the list must
    // be `maxAzs` long at synth time or `fromVpcAttributes` cannot pair each subnet with its zone.
    // The count must match the platform's subnet count or the imported mapping is wrong.
    const subnetIds = (exportName: string) => {
      const joined = Fn.split(',', importValue(exportName));
      return Array.from({ length: config.maxAzs }, (_, index) => Fn.select(index, joined));
    };

    this.vpc = Vpc.fromVpcAttributes(this, 'SharedVpc', {
      vpcId: importValue(NETWORK_EXPORTS.vpcId),
      availabilityZones: availabilityZoneTokens(config.maxAzs),
      publicSubnetIds: subnetIds(NETWORK_EXPORTS.publicSubnetIds),
      privateSubnetIds: subnetIds(NETWORK_EXPORTS.privateSubnetIds),
      isolatedSubnetIds: subnetIds(NETWORK_EXPORTS.databaseSubnetIds),
    });

    this.securityGroups = new TierSecurityGroups(this, 'SecurityGroups', { vpc: this.vpc });

    // zoneName comes from configuration, not an export: it is a known value (dev.example.com),
    // only the zone id is a deploy-time fact.
    this.zone = HostedZone.fromHostedZoneAttributes(this, 'SharedZone', {
      hostedZoneId: importValue(DNS_EXPORTS.hostedZoneId),
      zoneName: dns.zoneName,
    });
    this.certificate = Certificate.fromCertificateArn(
      this,
      'SharedCertificate',
      importValue(DNS_EXPORTS.certificateArn),
    );
    this.apiDomainName = `${dns.apiSubdomain}.${dns.zoneName}`;

    applyPlatformTags(this, config);
  }
}
