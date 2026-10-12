#!/usr/bin/env node
import 'source-map-support/register';

import { App } from 'aws-cdk-lib';

import { ENVIRONMENT_NAMES } from '../lib/config/types';
import { OrganizationStack, OrganizationAccountSpec } from '../lib/stacks/organization-stack';

const app = new App();

// Member accounts are created only for names with an `ACME_<NAME>_ACCOUNT_EMAIL` set: AWS
// requires a unique email per account and that is a decision no default can make for you. The
// names are the shared workload environment accounts, the shared-services account (`tooling`)
// and the security accounts (`log-archive`, `audit`). Deploying with none still creates the
// organization skeleton.
const ACCOUNT_NAMES = [...ENVIRONMENT_NAMES, 'tooling', 'log-archive', 'audit'];
const accounts: OrganizationAccountSpec[] = ACCOUNT_NAMES.map((name) => {
  const email = process.env[`ACME_${name.toUpperCase().replaceAll('-', '_')}_ACCOUNT_EMAIL`];
  return email === undefined ? undefined : { name, email };
}).filter((account): account is OrganizationAccountSpec => account !== undefined);

// Deployed once, into the management account - the account the active credentials belong to.
// ACME_COMPANY names the "company" in account naming (`acme-dev`); default 'acme'.
new OrganizationStack(app, 'acme-organization', {
  accounts,
  company: process.env.ACME_COMPANY ?? 'acme',
  // ACME_ALLOWED_REGIONS overrides the default (workload region + us-east-1 for ACM).
  allowedRegions: process.env.ACME_ALLOWED_REGIONS?.split(','),
  description: 'AWS Organization: OUs, member accounts, and org-wide SCPs (Phase 9)',
});
