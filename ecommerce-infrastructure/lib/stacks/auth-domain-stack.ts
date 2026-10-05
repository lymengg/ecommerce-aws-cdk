import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { IUserPool, ManagedLoginVersion, UserPoolDomain } from 'aws-cdk-lib/aws-cognito';
import { ARecord, AaaaRecord, IHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { UserPoolDomainTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

import { EnvironmentConfig } from '../config/types';
import { applyPlatformTags } from '../tags';

export interface AuthDomainStackProps extends StackProps {
  /** Environment specific configuration. No environment value is hardcoded in this stack. */
  readonly config: EnvironmentConfig;

  /** The user pool the managed login pages are served for. */
  readonly userPool: IUserPool;

  /**
   * The `us-east-1` certificate covering the custom domain, produced by the auth-certificate
   * stack. Cognito fronts a custom domain with a managed CloudFront distribution, and CloudFront
   * only reads certificates from `us-east-1` - which is also why the ARN arrives across a region
   * boundary and both stacks are created with `crossRegionReferences`.
   */
  readonly certificate: ICertificate;

  /** The hosted zone the `auth` alias record is created in. */
  readonly zone: IHostedZone;
}

/**
 * The Cognito custom domain: managed login at `auth.<zone>` instead of the default
 * `<prefix>.auth.<region>.amazoncognito.com` address.
 *
 * ```
 *   browser ──▶ auth.dev.example.com ──▶ Route 53 alias ──▶ Cognito-managed CloudFront
 *                                                              │
 *                                                    user pool domain (managed login v2)
 * ```
 *
 * This is deliberately a **separate stack deployed last**, after the frontend. Cognito validates
 * a custom domain at creation time by checking that the parent domain resolves to an A record -
 * for `auth.dev.example.com` that is `dev.example.com`, and the frontend stack is what publishes
 * that apex record. Putting the domain in the cognito stack instead would deploy it before the
 * apex exists and creation would fail; depending on the frontend from the cognito stack would
 * create a cycle (frontend -> application -> cognito). A leaf stack keeps the graph acyclic.
 *
 * A user pool has exactly one domain. Switching from a prefix domain replaces it, so the old
 * `*.amazoncognito.com` address stops working once this is applied - there is no way to serve both.
 */
export class AuthDomainStack extends Stack {
  /** The custom domain hosting the managed login pages. */
  public readonly userPoolDomain: UserPoolDomain;

  /** Fully qualified domain name managed login answers on, for example `auth.dev.example.com`. */
  public readonly authDomainName: string;

  constructor(scope: Construct, id: string, props: AuthDomainStackProps) {
    super(scope, id, props);

    const { config, userPool, certificate, zone } = props;
    const { dns } = config;

    if (dns === undefined) {
      // The app only creates this stack when the environment has a domain. This guard turns a
      // programming mistake into a clear synth-time error rather than a domain that cannot resolve.
      throw new Error(`AuthDomainStack requires config.dns to be set for environment "${config.environment}".`);
    }

    this.authDomainName = `${dns.authSubdomain}.${dns.zoneName}`;

    this.userPoolDomain = new UserPoolDomain(this, 'Domain', {
      userPool,
      customDomain: { domainName: this.authDomainName, certificate },
      // Managed login (version 2), not the classic hosted UI that Cognito uses by default. The
      // version applies to a custom domain exactly as it does to a prefix domain.
      managedLoginVersion: ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // Alias records, never CNAMEs: an alias is free and follows the managed distribution. Cognito
    // publishes the distribution's name on the domain's `CloudFrontDistribution` attribute, which
    // the target resolves - no custom resource. Both A and AAAA are created so the login page
    // answers on either address family.
    const recordTarget = RecordTarget.fromAlias(new UserPoolDomainTarget(this.userPoolDomain));
    new ARecord(this, 'AuthRecord', { zone, recordName: dns.authSubdomain, target: recordTarget });
    new AaaaRecord(this, 'AuthRecordIpv6', { zone, recordName: dns.authSubdomain, target: recordTarget });

    applyPlatformTags(this, config);

    new CfnOutput(this, 'AuthDomainUrl', {
      value: `https://${this.authDomainName}`,
      description: 'Base URL of the managed login pages (Cognito custom domain)',
      exportName: `ecommerce-${config.environment}-auth-domain-url`,
    });
  }
}
