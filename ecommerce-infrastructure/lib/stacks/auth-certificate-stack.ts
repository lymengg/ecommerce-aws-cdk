import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { Certificate, CertificateValidation, ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { IHostedZone } from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

import { EnvironmentConfig } from '../config/types';
import { applyPlatformTags } from '../tags';

export interface AuthCertificateStackProps extends StackProps {
  /** Environment specific configuration. No environment value is hardcoded in this stack. */
  readonly config: EnvironmentConfig;

  /**
   * The hosted zone the certificate validates against. Consumed across a region boundary - the
   * zone lives in the dns stack in the deployment region while this stack runs in `us-east-1` -
   * so both stacks are created with `crossRegionReferences` and CDK hands the zone id over via an
   * SSM parameter rather than a CloudFormation export, which cannot cross regions.
   */
  readonly zone: IHostedZone;
}

/**
 * The ACM certificate for the Cognito custom domain (`auth.<zone>`), deliberately in its own stack
 * in **`us-east-1`**.
 *
 * A Cognito custom domain is fronted by a CloudFront distribution that Cognito creates and manages,
 * and CloudFront - a global service - can only read certificates out of `us-east-1`. That is why
 * this certificate cannot live in the dns stack with the ALB certificate: the load balancer needs
 * its certificate in the deployment region, Cognito needs this one in `us-east-1`, and neither can
 * use the other's.
 *
 * Route 53 is a global service, so the DNS validation records this stack writes into the shared
 * hosted zone work from `us-east-1` exactly as they would from the deployment region.
 *
 * ```
 *   Route 53 hosted zone (global, owned by the dns stack)
 *          ▲ DNS validation records written from here
 *          │
 *   ACM certificate (us-east-1) ──▶ Cognito custom domain (auth.<zone>)
 *                                   in the auth-domain stack
 * ```
 */
export class AuthCertificateStack extends Stack {
  /** Certificate covering {@link authDomainName}, validated by DNS against the shared zone. */
  public readonly certificate: ICertificate;

  /** Fully qualified domain name managed login answers on, for example `auth.dev.example.com`. */
  public readonly authDomainName: string;

  constructor(scope: Construct, id: string, props: AuthCertificateStackProps) {
    super(scope, id, props);

    const { config, zone } = props;
    const { dns } = config;

    if (dns === undefined) {
      // The app only creates this stack when the environment has a domain. This guard turns a
      // programming mistake into a clear synth-time error rather than a certificate with a nonsense
      // name.
      throw new Error(`AuthCertificateStack requires config.dns to be set for environment "${config.environment}".`);
    }

    this.authDomainName = `${dns.authSubdomain}.${dns.zoneName}`;

    // A single-name certificate: the Cognito custom domain is exactly one host. No wildcard - a
    // `*.<zone>` certificate would cover this name too but would also authorise any other host an
    // attacker who obtained it could invent.
    this.certificate = new Certificate(this, 'Certificate', {
      domainName: this.authDomainName,
      validation: CertificateValidation.fromDns(zone),
    });

    applyPlatformTags(this, config);

    new CfnOutput(this, 'CertificateArn', {
      value: this.certificate.certificateArn,
      description: 'ARN of the us-east-1 ACM certificate covering the Cognito custom domain',
      exportName: `ecommerce-${config.environment}-auth-certificate-arn`,
    });
  }
}
