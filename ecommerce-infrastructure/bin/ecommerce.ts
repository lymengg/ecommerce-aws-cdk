#!/usr/bin/env node
import 'source-map-support/register';

import { App } from 'aws-cdk-lib';

import { EnvironmentConfig, getEnvironmentConfig, resolveEnvironmentName, resolveImageTag } from '../lib/config';
import { ApplicationStack } from '../lib/stacks/application-stack';
import { AuthCertificateStack } from '../lib/stacks/auth-certificate-stack';
import { AuthDomainStack } from '../lib/stacks/auth-domain-stack';
import { CognitoStack } from '../lib/stacks/cognito-stack';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { DnsStack } from '../lib/stacks/dns-stack';
import { EcrStack } from '../lib/stacks/ecr-stack';
import { FrontendStack } from '../lib/stacks/frontend-stack';
import { NetworkStack } from '../lib/stacks/network-stack';

/**
 * The one region Cognito custom domains can read a certificate from. A custom domain is fronted by
 * a Cognito-managed CloudFront distribution, and CloudFront - a global service - only reads ACM
 * certificates from `us-east-1`, wherever the user pool itself lives. This is a fixed AWS
 * constraint, not an environment decision, which is why it is a constant and not configuration.
 */
const COGNITO_CUSTOM_DOMAIN_CERTIFICATE_REGION = 'us-east-1';

const app = new App();

// The environment is selected by CDK context (`cdk deploy -c environment=prod`, defaulting to the
// value in cdk.json) or by the ENVIRONMENT variable, falling back to dev. See lib/config/index.ts.
const environment = resolveEnvironmentName(app);
const config = getEnvironmentConfig(environment);

// The image tag can be overridden at deploy time (`-c imageTag=v1.2.3` or IMAGE_TAG) without editing
// source. It is merged back into the configuration so the stacks still receive one config object.
const deployedConfig: EnvironmentConfig = {
  ...config,
  application: { ...config.application, imageTag: resolveImageTag(config, app) },
  // The frontend image has its own default tag but honours the same override, so one release tag can
  // pin both images.
  frontend: { ...config.frontend, imageTag: resolveImageTag(config, app, config.frontend.imageTag) },
};

const network = new NetworkStack(app, `ecommerce-network-${environment}`, {
  // Account and region come from the environment configuration, never from this file. When the
  // account is not configured explicitly the CDK CLI resolves it from the active credentials.
  env: {
    account: config.account,
    region: config.region,
  },
  config,
  description: `E-commerce platform network foundation (${environment})`,
});

// The container registry is deployed before the compute that consumes it: the ECS service cannot
// start until an image has been pushed, and an image can only be pushed once the repository exists.
const registry = new EcrStack(app, `ecommerce-ecr-${environment}`, {
  env: {
    account: config.account,
    region: config.region,
  },
  config: deployedConfig,
  description: `E-commerce platform container registry (${environment})`,
});

// The database stack owns the RDS instance and the secret holding its credentials. It needs the
// network (VPC and database security group) and nothing else, so it can be deployed independently
// of the compute that consumes it.
const database = new DatabaseStack(app, `ecommerce-database-${environment}`, {
  env: {
    account: config.account,
    region: config.region,
  },
  config: deployedConfig,
  vpc: network.vpc,
  databaseSecurityGroup: network.securityGroups.database,
  description: `E-commerce platform PostgreSQL database (${environment})`,
});

// Phase 3.5 DNS and TLS, created only when the environment has a delegated subdomain. It depends on
// no other stack - the hosted zone is created, never looked up - so it can be deployed in parallel
// with the network, registry and database stacks.
//
// Deploy-order contract: the zone must be delegated before the certificate can finish issuing. After
// this stack is deployed, copy the HostedZoneNameServers output into NS records at the registrar;
// ACM then completes the DNS validation on its own and the certificate becomes usable. Deploying the
// application stack before that leaves the HTTPS listener waiting on a certificate that is still
// pending, which is why the order below matters.
const dns =
  config.dns === undefined
    ? undefined
    : new DnsStack(app, `ecommerce-dns-${environment}`, {
        env: {
          account: config.account,
          region: config.region,
        },
        // The auth-certificate stack reads the hosted zone id from `us-east-1`; cross-region
        // references hand it over via SSM instead of a CloudFormation export, which cannot cross
        // regions.
        crossRegionReferences: true,
        config: deployedConfig,
        description: `E-commerce platform public DNS and TLS certificate (${environment})`,
      });

// Phase 4 authentication. The user pool and the confidential app client the BFF authenticates as
// live in their own stack, ahead of the compute that consumes them, so the pool can be retained and
// its users survive a redeployment of the application.
//
// The app client needs the API's fully qualified domain name for its exact callback URIs, so it is
// derived from `config.dns` (never imported as a string). Authentication requires a `Secure` session
// cookie, so the validator guarantees a domain is configured by the time the app runs; this guard
// turns a programming mistake into a clear error rather than a broken callback URL.
//
// Deploy order is therefore dns -> cognito -> application.
if (config.dns === undefined || dns === undefined) {
  throw new Error(`Phase 4 authentication requires a delegated domain for environment "${environment}".`);
}
// The SPA: where the browser lands after login and after logout, and a registered logout URI.
const frontendUrl = config.auth.frontendUrl;

// The certificate for the Cognito custom domain lives in `us-east-1`, the only region a
// Cognito-managed CloudFront distribution can read it from. It is its own stack because a stack is
// bound to a single region; the hosted zone it validates against is global Route 53, so the
// validation records work from there. Deploy order: dns -> auth-certificate -> auth-domain.
const authCertificate = new AuthCertificateStack(app, `ecommerce-auth-cert-${environment}`, {
  env: {
    account: config.account,
    region: COGNITO_CUSTOM_DOMAIN_CERTIFICATE_REGION,
  },
  crossRegionReferences: true,
  config: deployedConfig,
  zone: dns.zone,
  description: `E-commerce platform Cognito custom domain certificate (${environment})`,
});

const cognito = new CognitoStack(app, `ecommerce-cognito-${environment}`, {
  env: {
    account: config.account,
    region: config.region,
  },
  config: deployedConfig,
  description: `E-commerce platform authentication (${environment})`,
});

// The application stack consumes the network stack's VPC and security groups, the registry, the
// database stack's endpoint and credentials secret, the DNS stack's hosted zone and certificate,
// and the Cognito stack's user pool, app client and client secret, so the CDK CLI orders the
// stacks: network, registry, database, dns and cognito must exist before compute can attach to
// them. The references are by object, never by ARN string, and there is no path back from any
// producer to the application stack, so the dependency graph stays acyclic.
const application = new ApplicationStack(app, `ecommerce-application-${environment}`, {
  env: {
    account: config.account,
    region: config.region,
  },
  config: deployedConfig,
  vpc: network.vpc,
  repository: registry.repository,
  albSecurityGroup: network.securityGroups.alb,
  applicationSecurityGroup: network.securityGroups.application,
  database: {
    host: database.instance.dbInstanceEndpointAddress,
    port: database.instance.dbInstanceEndpointPort,
    databaseName: config.database.databaseName,
    secret: database.credentialsSecret,
  },
  dns: { zone: dns.zone, certificate: dns.certificate, domainName: dns.apiDomainName },
  auth: {
    issuerUrl: cognito.issuerUrl,
    userPoolClientId: cognito.userPoolClient.userPoolClientId,
    clientSecret: cognito.clientSecret,
    frontendUrl,
  },
  description: `E-commerce platform application compute (${environment})`,
});

// Phase 4.5 frontend: the Nuxt SPA, served by nginx as a second Fargate service behind the load
// balancer that already exists, on the apex of the delegated subdomain. The SPA and the API are then
// same-site, which is what lets the BFF's session cookie work across them.
//
// Deploy order: ... -> application -> frontend. The frontend consumes the ECS cluster, the HTTPS
// listener, the load balancer, the application security group and the frontend repository, all by
// reference - so it is deployed after the compute and can be redeployed on its own.
//
// A CloudFront distribution would be the natural CDN in front of this service, but this account
// cannot create CloudFront resources until AWS Support verifies it; the load balancer serves the
// files directly until then, and adding the distribution later needs no change here.
const httpsListener = application.api.httpsListener;
if (httpsListener === undefined) {
  // config.dns is required, so the certificate and the HTTPS listener always exist.
  throw new Error(`The frontend requires the HTTPS listener for environment "${environment}".`);
}

const frontend = new FrontendStack(app, `ecommerce-frontend-${environment}`, {
  env: {
    account: config.account,
    region: config.region,
  },
  config: deployedConfig,
  repository: registry.frontendRepository,
  cluster: application.cluster,
  applicationSecurityGroup: network.securityGroups.application,
  loadBalancer: application.api.loadBalancer,
  albSecurityGroup: network.securityGroups.alb,
  httpsListener,
  zone: dns.zone,
  description: `E-commerce platform frontend hosting (${environment})`,
});

// The Cognito custom domain (`auth.<zone>`) is a leaf stack deployed last on purpose. Cognito
// verifies at domain creation that the parent domain resolves an A record, and the frontend stack
// is what publishes the apex alias - so the domain cannot exist before the frontend. Object
// references already force this stack after cognito (the pool), dns (the zone) and
// auth-certificate (the cert, via a cross-region reference); only the apex-record ordering is not
// expressible as a value, hence the explicit dependency.
const authDomain = new AuthDomainStack(app, `ecommerce-auth-domain-${environment}`, {
  env: {
    account: config.account,
    region: config.region,
  },
  crossRegionReferences: true,
  config: deployedConfig,
  userPool: cognito.userPool,
  certificate: authCertificate.certificate,
  zone: dns.zone,
  description: `E-commerce platform Cognito custom domain (${environment})`,
});
authDomain.addStackDependency(frontend);
