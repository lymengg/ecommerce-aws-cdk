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
   * Account name suffix: `dev`/`uat`/`prod` for the shared workload accounts, `tooling` for the
   * account that hosts the CI/CD pipeline and the shared container registry, `log-archive` and
   * `audit` for the security accounts. Rendered as the member account's name
   * (`<company>-<name>` - see {@link OrganizationStackProps.company}) and placed in the OU the
   * name belongs to (see the tree in {@link OrganizationStack}).
   */
  readonly name: string;

  /**
   * Email address the account's root user is registered under. AWS requires a unique email per
   * account; it is read from `ACME_<NAME>_ACCOUNT_EMAIL` (dashes become underscores, so the
   * log archive's variable is `ACME_LOG_ARCHIVE_ACCOUNT_EMAIL`) and accounts are created only
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
   * Company prefix used in account naming, following the `<company>-<account>` convention real
   * organizations use: `acme-dev`, `acme-tooling`, `acme-log-archive`. Defaults to `acme` -
   * replace it with the real name.
   */
  readonly company?: string;

  /**
   * Regions member accounts are allowed to operate in; every other region is denied org-wide by
   * the `deny-unapproved-regions` SCP. Defaults to the platform's two real regions: the workload
   * region and `us-east-1` (CloudFront/ACM certificates are us-east-1-only). Global services are
   * exempted in the policy itself.
   */
  readonly allowedRegions?: string[];
}

/**
 * The organizational-unit layout: parent OUs at the root, the environment OUs under `workloads`.
 * `log-archive`, `audit` and `tooling` live directly inside their parent because one OU per
 * account would be structure for structure's sake.
 */
const OU_TREE: Record<string, readonly string[]> = {
  workloads: ['dev', 'uat', 'prod'],
  security: [],
  tooling: [],
};

/** Which OU each creatable account belongs to. */
const ACCOUNT_OU: Record<string, string> = {
  dev: 'dev',
  uat: 'uat',
  prod: 'prod',
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
 *   ├── workloads          (OU - shared environment accounts that hold every service's
 *   │   │                    workloads; per-service accounts are the upgrade path if a second
 *   │   │                    service ever needs its own blast-radius boundary)
 *   │   ├── dev            (OU + member account `acme-dev`, when ACME_DEV_ACCOUNT_EMAIL is set)
 *   │   ├── uat            (OU + member account `acme-uat`, when ACME_UAT_ACCOUNT_EMAIL is set)
 *   │   └── prod           (OU + member account `acme-prod`, when ACME_PROD_ACCOUNT_EMAIL is set)
 *   ├── security           (OU + member accounts - log-archive and audit, when their
 *   │                        ACME_*_ACCOUNT_EMAIL variables are set)
 *   └── tooling            (OU + member account, when ACME_TOOLING_ACCOUNT_EMAIL is set -
 *                            the long-term home of the pipeline and the shared ECR registry)
 * ```
 *
 * Three structural decisions, all deliberate:
 *
 * - Environment accounts are shared across services: all of a company's services deploy into
 *   the same `dev`/`uat`/`prod` accounts, isolated by resource naming, tags, and scoped IAM
 *   roles rather than an account boundary. The env OUs are still the SCP attachment point
 *   ("prod is stricter than dev"). If a service later needs its own accounts, the flat
 *   workloads OU can grow `workloads/<service>/<env>` children without restructuring the
 *   rest of the tree.
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
 * SCPs (deny networking writes on `workloads`, deny destructive ops on `workloads/prod`) need
 * principal exemptions for the deploy roles and are intentionally left for a later pass.
 *
 * Member accounts are created by CloudFormation (`AWS::Organizations::Account`), which also
 * creates the `OrganizationAccountAccessRole` the pipeline's bootstrap trusts. Once an account
 * exists, its id is exported as an output - that is the value `ACME_<ENV>_ACCOUNT` wants,
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

    // The tree first, then the accounts hang off it: every leaf OU exists whether or not its
    // account does yet, so the structure is stable even while accounts are added incrementally.
    const ous = new Map<string, CfnOrganizationalUnit>();
    for (const [parent, children] of Object.entries(OU_TREE)) {
      const parentOu = new CfnOrganizationalUnit(this, `${pascal(parent)}Ou`, {
        name: parent,
        parentId: organization.attrRootId,
      });
      ous.set(parent, parentOu);
      for (const child of children) {
        ous.set(child, new CfnOrganizationalUnit(this, `${pascal(child)}Ou`, { name: child, parentId: parentOu.attrId }));
      }
    }

    for (const { name, email } of props?.accounts ?? []) {
      const parentOu = ous.get(ACCOUNT_OU[name] ?? name);
      if (parentOu === undefined) {
        throw new Error(`No OU for account "${name}" - add it to ACCOUNT_OU in organization-stack.ts`);
      }
      const account = new CfnAccount(this, `${pascal(name)}Account`, {
        accountName: `${company}-${name}`,
        email,
        parentIds: [parentOu.attrId],
        roleName: 'OrganizationAccountAccessRole',
      });
      // Removing the stack must never detach a live account: the account predates and outlives
      // whatever this stack was deployed to do.
      account.applyRemovalPolicy(RemovalPolicy.RETAIN);

      new CfnOutput(this, `${pascal(name)}AccountId`, {
        value: account.attrAccountId,
        description: `Account id of the ${name} member account - the ACME_${name.toUpperCase().replaceAll('-', '_')}_ACCOUNT value`,
        exportName: `${company}-${name}-account-id`,
      });
    }

    Tags.of(this).add('Project', PROJECT_TAG);
    Tags.of(this).add('ManagedBy', MANAGED_BY_TAG);
    Tags.of(this).add('Environment', 'shared');
  }
}
