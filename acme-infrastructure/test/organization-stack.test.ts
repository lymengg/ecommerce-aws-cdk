import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import {
  OrganizationAccountSpec,
  OrganizationStack,
  OrganizationStackProps,
} from '../lib/stacks/organization-stack';

function buildTemplate(
  accounts: OrganizationAccountSpec[] = [],
  props: Omit<OrganizationStackProps, 'accounts'> = {},
): Template {
  const app = new App();
  const stack = new OrganizationStack(app, 'test-organization', { ...props, accounts });
  return Template.fromStack(stack);
}

describe('OrganizationStack', () => {
  test('creates the organization with all features enabled', () => {
    buildTemplate().hasResourceProperties('AWS::Organizations::Organization', {
      FeatureSet: 'ALL',
    });
  });

  test('lays out the OU tree - shared environment OUs plus security and tooling', () => {
    const template = buildTemplate();

    const ous = Object.values(template.findResources('AWS::Organizations::OrganizationalUnit')) as any[];
    const names = ous.map((ou) => ou.Properties.Name).sort();
    expect(names).toEqual(['dev', 'prod', 'security', 'tooling', 'uat', 'workloads']);
  });

  test('names member accounts <company>-<name> like a real organization', () => {
    const template = buildTemplate([
      { name: 'uat', email: 'uat@example.com' },
      { name: 'prod', email: 'prod@example.com' },
      { name: 'tooling', email: 'tooling@example.com' },
    ]);

    template.hasResourceProperties('AWS::Organizations::Account', {
      AccountName: 'acme-uat',
      Email: 'uat@example.com',
      RoleName: 'OrganizationAccountAccessRole',
    });
    template.hasResourceProperties('AWS::Organizations::Account', {
      AccountName: 'acme-prod',
      Email: 'prod@example.com',
    });
    template.hasResourceProperties('AWS::Organizations::Account', {
      AccountName: 'acme-tooling',
      Email: 'tooling@example.com',
    });
    template.resourceCountIs('AWS::Organizations::Account', 3);
  });

  test('places security and tooling accounts under their parent OUs', () => {
    const template = buildTemplate([
      { name: 'log-archive', email: 'logs@example.com' },
      { name: 'audit', email: 'audit@example.com' },
    ]);

    template.hasResourceProperties('AWS::Organizations::Account', {
      AccountName: 'acme-log-archive',
      Email: 'logs@example.com',
    });
    template.hasResourceProperties('AWS::Organizations::Account', {
      AccountName: 'acme-audit',
      Email: 'audit@example.com',
    });
  });

  test('attaches the org-wide SCP floor at the root', () => {
    const template = buildTemplate();

    template.hasResourceProperties('AWS::Organizations::Policy', {
      Name: 'acme-deny-leave-organization',
      Type: 'SERVICE_CONTROL_POLICY',
      Content: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Deny', Action: 'organizations:LeaveOrganization', Resource: '*' },
        ],
      },
    });
    template.hasResourceProperties('AWS::Organizations::Policy', {
      Name: 'acme-deny-audit-trail-tampering',
      Type: 'SERVICE_CONTROL_POLICY',
    });
    template.hasResourceProperties('AWS::Organizations::Policy', {
      Name: 'acme-deny-unapproved-regions',
      Type: 'SERVICE_CONTROL_POLICY',
      Content: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Deny',
            NotAction: Match.arrayWith(['iam:*']),
            Resource: '*',
            Condition: {
              StringNotEquals: { 'aws:RequestedRegion': ['ap-southeast-1', 'us-east-1'] },
            },
          },
        ],
      },
    });
    template.resourceCountIs('AWS::Organizations::Policy', 3);
  });

  test('retains member accounts - stack deletion must not detach them', () => {
    const template = buildTemplate([{ name: 'prod', email: 'prod@example.com' }]);

    template.hasResource('AWS::Organizations::Account', { DeletionPolicy: 'Retain' });
  });

  test('exports the member account ids as the ACME_<NAME>_ACCOUNT values', () => {
    const template = buildTemplate([{ name: 'prod', email: 'prod@example.com' }]);

    template.hasOutput('ProdAccountId', {
      Export: { Name: 'acme-prod-account-id' },
    });
  });
});
