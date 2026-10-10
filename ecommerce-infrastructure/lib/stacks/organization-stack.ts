import { CfnOutput, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import {
  CfnAccount,
  CfnOrganization,
  CfnOrganizationalUnit,
  CfnPolicy,
} from 'aws-cdk-lib/aws-organizations';
import { Construct } from 'constructs';

import { MANAGED_BY_TAG, PROJECT_TAG } from '../tags';

export interface OrganizationAccountSpec {
  /**
   * Account name suffix: `dev`/`uat`/`prod` for workload accounts, `tooling` for the account that
   * hosts the CI/CD pipeline and the shared container registry, `log-archive` and `audit` for the
   * security accounts. Rendered as the member account's name (see {@link OrganizationStackProps.company})
   * and placed in the OU the name belongs to (see the tree in {@link OrganizationStack}).
   */
  readonly name: string;

  /**
   * The service a workload account belongs to (`ecommerce`, `payments`, ...). Workload accounts
   * must set it - it selects the `workloads/<service>/<env>` OU and the middle segment of the
   * account name `<company>-<service>-<env>`. Shared-function accounts (tooling, log-archive,
   * audit) leave it undefined: they are not service-scoped and land in their functional OU.
   */
  readonly service?: string;

  /**
   * Email address the account's root user is registered under. AWS requires a unique email per
   * account; it is read from `ECOMMERCE_<NAME>_ACCOUNT_EMAIL` (dashes become underscores, so the
   * log archive's variable is `ECOMMERCE_LOG_ARCHIVE_ACCOUNT_EMAIL`) and accounts are created only
   * for names that have one - the stack is intentionally safe to deploy incrementally.
   */
  readonly email: string;
}

export interface OrganizationStackProps extends StackProps {
  /**
   * Member accounts to create, in addition to the organizational units. The management account
   * (where this stack deploys) is not listed - it exists by definition.
   */
  readonly accounts: OrganizationAccountSpec[];

  /**
   * Company prefix used in account naming, following the `<company>-<workload>` convention real
   * organizations use: workload accounts render as `<company>-<service>-<env>` (company →
   * service → environment), shared-function accounts as `<company>-<name>` (`acme-tooling`,
   * `acme-log-archive`). Defaults to `acme` - replace it with the real name.
   */
  readonly company?: string;

  /**
   * Services that get a workload account set. Each becomes a `workloads/<service>` OU with the
   * environment OUs inside it - the shape a multi-team organization grows into, where team A's
   * accounts are a distinct blast-radius boundary from team B's. Defaults to `['ecommerce']`.
   */
  readonly services?: string[];

  /**
   * Regions member accounts are allowed to operate in; every other region is denied org-wide by
   * the `deny-unapproved-regions` SCP. Defaults to the platform's two real regions: the workload
   * region and `us-east-1` (CloudFront/ACM certificates are us-east-1-only). Global services are
   * exempted in the policy itself.
   */
  readonly allowedRegions?: string[];
}

/**
 * The organizational units that hang directly off the root, other than `workloads` - which is
 * built dynamically: one OU per service, the environment OUs inside it. `log-archive`, `audit`
 * and `tooling` live directly inside their parent OU because one OU per account would be
 * structure for structure's sake.
 */
const ROOT_FUNCTIONAL_OUS = ['workloads', 'security', 'tooling'] as const;

/** The environments every service gets an OU (and optionally an account) for. */
const ENVIRONMENTS = ['dev', 'uat', 'prod'] as const;

/** Which functional OU a shared-function account belongs to. */
const FUNCTIONAL_ACCOUNT_OU: Record<string, string> = {
  'log-archive': 'security',
  audit: 'security',
  tooling: 'tooling',
};

/**
 * Global services exempted from the region-deny SCP: they only exist in us-east-1 (or report no
 * region at all), so a blanket region deny would break IAM, billing, and DNS for every member
 * account. The list is deliberately conservative - extend it when a member account needs another
 * global service, not preemptively.
 */
const REGION_EXEMPT_GLOBAL_SERVICES = [
  'iam:*',
  'sts:*',
  'organizations:*',
  'route53:*',
  'route53domains:*',
  'cloudfront:*',
  'globalaccelerator:*',
  'budgets:*',
  'ce:*',
  'cur:*',
  'aws-portal:*',
  'support:*',
  'account:*',
  's3:ListAllMyBuckets',
  's3:GetBucketLocation',
];

const pascal = (name: string): string =>
  name.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');

/**
 * Phase 9 multi-account structure, deployed once in the management account.
 *
 * ```
 *   Root                    (management account - pure payer/admin; best practice is that it
 *   │                        hosts NO workloads. Today it happens to host dev + the pipeline +
 *   │                        the shared registry, and those migrate to member accounts below)
 *   ├── workloads          (OU - one child OU per service; accounts are per service x env:
 *   │   │                    `acme-ecommerce-dev`, `acme-payments-prod`, ...)
 *   │   └── ecommerce      (service OU - the team blast-radius boundary an SCP can scope to)
 *   │       ├── dev        (OU + member account, when ECOMMERCE_DEV_ACCOUNT_EMAIL is set)
 *   │       ├── uat        (OU + member account, when ECOMMERCE_UAT_ACCOUNT_EMAIL is set)
 *   │       └── prod       (OU + member account, when ECOMMERCE_PROD_ACCOUNT_EMAIL is set)
 *   ├── security           (OU + member accounts - log-archive and audit, when their
 *   │                        ECOMMERCE_*_ACCOUNT_EMAIL variables are set)
 *   └── tooling            (OU + member account, when ECOMMERCE_TOOLING_ACCOUNT_EMAIL is set -
 *                            the long-term home of the pipeline and the shared ECR registry)
 * ```
 *
 * Three structural decisions, all deliberate:
 *
 * - OUs nest service → environment (rather than one flat workloads OU): a service OU is the team
 *   blast-radius boundary ("deny networking writes in all of ecommerce's accounts" is one SCP
 *   attachment), and the env OUs inside it keep "prod is stricter than dev" expressible.
 * - `security` exists from day one because it is the hardest piece to retrofit: log-archive holds
 *   the org-wide CloudTrail/Config aggregation and audit holds read-only security tooling access -
 *   Control Tower provisions both automatically, and a hand-rolled organization needs them just
 *   as much.
 * - `tooling` is where the pipeline and the shared registry belong; today they live in the
 *   management account, and the `registry` location in `bin/pipeline.ts` is the migration seam.
 *
 * Three starter SCPs are attached at the root (they bind every member account, never the
 * management account - SCPs do not apply to it): deny `LeaveOrganization`, deny tampering with
 * the audit trail (CloudTrail/Config/GuardDuty), and deny unapproved regions. They are safe to
 * attach unconditionally - they carve away edges nobody legitimate uses. Environment/team-scoped
 * SCPs (deny networking writes on `workloads`, deny destructive ops on the per-service `prod`
 * OUs) need principal exemptions for the deploy roles and are intentionally left for a later pass.
 *
 * Member accounts are created by CloudFormation (`AWS::Organizations::Account`), which also
 * creates the `OrganizationAccountAccessRole` the pipeline's bootstrap trusts. Once an account
 * exists, its id is exported as an output - that is the value `ECOMMERCE_<ENV>_ACCOUNT` wants,
 * which is what activates the environment in the pipeline and in the registry's pull policy.
 * Deploying this stack with no account emails creates just the organization skeleton, which is a
 * valid and useful intermediate state.
 */
export class OrganizationStack extends Stack {
  constructor(scope: Construct, id: string, props?: OrganizationStackProps) {
    super(scope, id, props);

    const organization = new CfnOrganization(this, 'Organization', {
      featureSet: 'ALL',
    });

    const company = props?.company ?? 'acme';

    // Root-attached SCPs: the org-wide permission ceiling. They bind every member account
    // (management is always exempt) and cascade down every OU, so these three are the floor
    // nothing below can reopen.
    const scp = (id: string, name: string, description: string, statement: object): CfnPolicy =>
      new CfnPolicy(this, `${id}Scp`, {
        name: `${company}-${name}`,
        description,
        type: 'SERVICE_CONTROL_POLICY',
        content: { Version: '2012-10-17', Statement: [statement] },
        targetIds: [organization.attrRootId],
      });

    scp(
      'DenyLeaveOrganization',
      'deny-leave-organization',
      'No member account may detach itself from this organization.',
      { Effect: 'Deny', Action: 'organizations:LeaveOrganization', Resource: '*' },
    );

    scp(
      'DenyAuditTrailTampering',
      'deny-audit-trail-tampering',
      'No member account may stop, delete, or reconfigure CloudTrail, Config, or GuardDuty - the audit trail outlives the account that generated it.',
      {
        Effect: 'Deny',
        Action: [
          'cloudtrail:StopLogging',
          'cloudtrail:DeleteTrail',
          'cloudtrail:UpdateTrail',
          'cloudtrail:PutEventSelectors',
          'config:StopConfigurationRecorder',
          'config:DeleteConfigurationRecorder',
          'config:DeleteDeliveryChannel',
          'guardduty:DisassociateFromMasterAccount',
          'guardduty:DisassociateFromAdministratorAccount',
          'guardduty:DeleteDetector',
        ],
        Resource: '*',
      },
    );

    const allowedRegions = props?.allowedRegions ?? ['ap-southeast-1', 'us-east-1'];
    scp(
      'DenyUnapprovedRegions',
      'deny-unapproved-regions',
      `Member accounts may only operate in ${allowedRegions.join(', ')}; global services are exempt.`,
      {
        Effect: 'Deny',
        NotAction: REGION_EXEMPT_GLOBAL_SERVICES,
        Resource: '*',
        Condition: { StringNotEquals: { 'aws:RequestedRegion': allowedRegions } },
      },
    );

    // OUs are keyed by path (`workloads/ecommerce/dev`) because the same leaf name appears under
    // every service. The whole tree is created up front so it is stable even while accounts are
    // still being added incrementally.
    const ous = new Map<string, CfnOrganizationalUnit>();
    const ou = (path: string, name: string, parentId: string): CfnOrganizationalUnit => {
      const unit = new CfnOrganizationalUnit(this, `${pascal(path.replaceAll('/', '-'))}Ou`, {
        name,
        parentId,
      });
      ous.set(path, unit);
      return unit;
    };

    for (const functional of ROOT_FUNCTIONAL_OUS) {
      const parent = ou(functional, functional, organization.attrRootId);
      if (functional === 'workloads') {
        for (const service of props?.services ?? ['ecommerce']) {
          const serviceOu = ou(`workloads/${service}`, service, parent.attrId);
          for (const env of ENVIRONMENTS) {
            ou(`workloads/${service}/${env}`, env, serviceOu.attrId);
          }
        }
      }
    }

    // Workload accounts name the service they host (`acme-ecommerce-dev`); shared-function
    // accounts are not service-scoped (`acme-tooling`).
    const accountName = ({ name, service }: OrganizationAccountSpec) =>
      service === undefined ? `${company}-${name}` : `${company}-${service}-${name}`;

    for (const spec of props?.accounts ?? []) {
      const { name, service, email } = spec;
      const ouPath =
        service === undefined ? FUNCTIONAL_ACCOUNT_OU[name] : `workloads/${service}/${name}`;
      const parentOu = ouPath === undefined ? undefined : ous.get(ouPath);
      if (parentOu === undefined) {
        throw new Error(
          `No OU for account "${name}"${service === undefined ? '' : ` of service "${service}"`} - ` +
            `add it to ${service === undefined ? 'FUNCTIONAL_ACCOUNT_OU' : 'props.services'} in organization-stack.ts`,
        );
      }
      // The construct id includes the service: `dev` exists once per service, but each is a
      // distinct account (ecommerce-dev vs payments-dev).
      const specId = pascal(service === undefined ? name : `${service}-${name}`);
      const account = new CfnAccount(this, `${specId}Account`, {
        accountName: accountName(spec),
        email,
        parentIds: [parentOu.attrId],
        roleName: 'OrganizationAccountAccessRole',
      });
      // Removing the stack must never detach a live account: the account predates and outlives
      // whatever this stack was deployed to do.
      account.applyRemovalPolicy(RemovalPolicy.RETAIN);

      new CfnOutput(this, `${specId}AccountId`, {
        value: account.attrAccountId,
        description: `Account id of the ${name} member account - the ECOMMERCE_${name.toUpperCase().replaceAll('-', '_')}_ACCOUNT value`,
        exportName: `${accountName(spec)}-account-id`,
      });
    }

    Tags.of(this).add('Project', PROJECT_TAG);
    Tags.of(this).add('ManagedBy', MANAGED_BY_TAG);
    Tags.of(this).add('Environment', 'shared');
  }
}
