#!/usr/bin/env node
import 'source-map-support/register';

import { App } from 'aws-cdk-lib';

import { ENVIRONMENT_NAMES } from '../lib/config/types';
import { OrganizationStack, OrganizationAccountSpec } from '../lib/stacks/organization-stack';

const app = new App();

// Member accounts are created only for names with an `ECOMMERCE_<NAME>_ACCOUNT_EMAIL` set: AWS
// requires a unique email per account and that is a decision no default can make for you. The
// names are the workload environments (which belong to a service - this project's `ecommerce`),
// the shared-services account (`tooling`) and the security accounts (`log-archive`, `audit`).
// Deploying with none still creates the organization skeleton.
const SERVICE = 'ecommerce';
const ACCOUNT_NAMES = [...ENVIRONMENT_NAMES, 'tooling', 'log-archive', 'audit'];
const accounts: OrganizationAccountSpec[] = ACCOUNT_NAMES.map((name): OrganizationAccountSpec | undefined => {
  const email = process.env[`ECOMMERCE_${name.toUpperCase().replaceAll('-', '_')}_ACCOUNT_EMAIL`];
  if (email === undefined) {
    return undefined;
  }
  return (ENVIRONMENT_NAMES as readonly string[]).includes(name)
    ? { name, service: SERVICE, email }
    : { name, email };
}).filter((account): account is OrganizationAccountSpec => account !== undefined);

// Deployed once, into the management account - the account the active credentials belong to.
// ECOMMERCE_COMPANY names the "company" in account naming (`acme-ecommerce-dev`); default 'acme'.
new OrganizationStack(app, 'ecommerce-organization', {
  accounts,
  company: process.env.ECOMMERCE_COMPANY ?? 'acme',
  services: [SERVICE],
  // ECOMMERCE_ALLOWED_REGIONS overrides the default (workload region + us-east-1 for ACM).
  allowedRegions: process.env.ECOMMERCE_ALLOWED_REGIONS?.split(','),
  description: 'AWS Organization: OUs, member accounts, and org-wide SCPs (Phase 9)',
});
