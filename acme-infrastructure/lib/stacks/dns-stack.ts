import { CfnOutput, Fn, Stack, StackProps } from 'aws-cdk-lib';
import { Certificate, CertificateValidation, ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { CfnHostedZone, HostedZone, IHostedZone } from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

import { EnvironmentConfig } from '../config/types';
import { applyPlatformTags } from '../tags';

export interface DnsStackProps extends StackProps {
  /** Environment specific configuration. No environment value is hardcoded in this stack. */
  readonly config: EnvironmentConfig;
}

/**
 * Phase 3.5 public DNS and TLS: a Route 53 hosted zone for the delegated subdomain and an ACM
 * certificate covering the API's fully qualified domain name.
 *
 * ```
 *   registrar NS records ──▶ Route 53 hosted zone (dev.example.com)
 *                                    │
 *                     ACM DNS validation CNAME (created and managed by ACM)
 *                                    │
 *                                    ▼
 *                            ACM certificate (api.dev.example.com)
 * ```
 *
 * The zone is **created**, never looked up: there is no `fromLookup` or `fromHostedZoneAttributes`
 * anywhere in this app, so `cdk synth` keeps working with zero AWS credentials. The certificate is
 * validated **by DNS** against that zone. ACM creates the validation CNAME inside the zone itself,
 * so there is no email approval to click, no manual record to add and no expiry to track by hand.
 *
 * ACM renews the certificate automatically for as long as the zone exists **and the certificate is
 * associated with an integrated service** - here, the load balancer listener. That is why the
 * certificate reads `RenewalEligibility: INELIGIBLE` until the application stack attaches it: ACM
 * only manages renewal for certificates that are actually in use (or exported).
 *
 * The zone and the certificate live in their own stack, ahead of the compute that consumes them, so
 * the certificate can be issued once and the application stack can be replaced freely without
 * touching it. This is also why the certificate stays in the deployment region (`ap-southeast-1`):
 * an ALB certificate must. A future CloudFront distribution (Phase 6) would need its own
 * certificate in `us-east-1`, because CloudFront only reads certificates from there.
 */
export class DnsStack extends Stack {
  /** The public hosted zone for the delegated subdomain. */
  public readonly zone: IHostedZone;

  /** Certificate covering {@link apiDomainName}, validated by DNS against {@link zone}. */
  public readonly certificate: ICertificate;

  /** Fully qualified domain name the API answers on, for example `api.dev.example.com`. */
  public readonly apiDomainName: string;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);

    const { config } = props;
    const { dns } = config;

    if (dns === undefined) {
      // The app only creates this stack when `config.dns` is set, and the validator refuses a
      // production environment without it. This guard turns a programming mistake into a clear
      // synth-time error instead of a stack with no zone in it.
      throw new Error(`DnsStack requires config.dns to be set for environment "${config.environment}".`);
    }

    this.zone = new HostedZone(this, 'Zone', {
      zoneName: dns.zoneName,
      comment: `Public hosted zone for the ${config.environment} e-commerce platform`,
    });

    // The L2 HostedZone exposes no removal policy, so the decision is applied to the underlying
    // CfnHostedZone through the escape hatch: dev deletes the zone with the stack, uat and prod
    // retain it so a stray `cdk destroy` cannot take the platform's DNS with it. See the destroy
    // caveat in the README - a retained zone keeps billing and still needs its registrar NS records
    // removed by hand.
    (this.zone.node.defaultChild as CfnHostedZone).applyRemovalPolicy(config.removalPolicy);

    this.apiDomainName = `${dns.apiSubdomain}.${dns.zoneName}`;

    // One certificate for the whole platform's public names: the API and the apex the SPA is served
    // from. Both terminate on the same load balancer, so a single certificate with a subject
    // alternative name is simpler than two certificates and two SNI entries - and it is still
    // exactly two names, no wildcard.
    this.certificate = new Certificate(this, 'Certificate', {
      domainName: this.apiDomainName,
      subjectAlternativeNames: [dns.zoneName],
      validation: CertificateValidation.fromDns(this.zone),
    });

    applyPlatformTags(this, config);
    this.createOutputs(config);
  }

  /**
   * Publishes the delegation values the registrar needs and the identifiers the application stack
   * consumes by reference. Export names are environment specific so dev, uat and prod coexist in
   * one account.
   */
  private createOutputs(config: EnvironmentConfig): void {
    const exportPrefix = `ecommerce-${config.environment}`;

    new CfnOutput(this, 'HostedZoneNameServers', {
      // The name servers are a list attribute of the zone, so they are joined with Fn.join rather
      // than Array.join: the latter would stringify the list token itself.
      value: Fn.join(',', this.zone.hostedZoneNameServers ?? []),
      description: 'Name servers to add as NS records at the registrar to delegate the subdomain',
      exportName: `${exportPrefix}-hosted-zone-name-servers`,
    });

    new CfnOutput(this, 'CertificateArn', {
      value: this.certificate.certificateArn,
      description: 'ARN of the ACM certificate covering the API domain',
      exportName: `${exportPrefix}-certificate-arn`,
    });

    new CfnOutput(this, 'ApiDomainName', {
      value: this.apiDomainName,
      description: 'Fully qualified domain name the API answers on',
      exportName: `${exportPrefix}-api-domain-name`,
    });
  }
}
