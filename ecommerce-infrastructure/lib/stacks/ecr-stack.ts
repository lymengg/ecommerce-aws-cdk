import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Repository, TagStatus } from 'aws-cdk-lib/aws-ecr';
import { AccountPrincipal, Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

import { MANAGED_BY_TAG, PROJECT_TAG } from '../tags';

/** Untagged images are build leftovers; they are expired rather than kept forever. */
const UNTAGGED_IMAGE_MAX_AGE = Duration.days(14);

/**
 * Where the shared registry lives: the pipeline account today, a dedicated tooling account after
 * Phase 9. Every environment's compute builds the repository ARNs from this location - a name and
 * account pair, never a construct reference, because references cannot cross stage boundaries.
 */
export interface RegistryLocation {
  /**
   * Account hosting the repositories. Omit for a same-account deployment; the stack importing a
   * repository then resolves the deployer's account.
   */
  readonly account?: string;

  /** Region hosting the repositories. All current environments share `ap-southeast-1`. */
  readonly region: string;
}

/**
 * One repository pair serves every environment: the image is built once per commit and the
 * identical artifact is promoted dev -> uat -> prod, rather than rebuilt per environment (which
 * would produce different digests and weaken the "what was tested is what ships" guarantee).
 * Names are environment-agnostic on purpose - the environment lives in the deployment, not the
 * image.
 */
export const API_REPOSITORY_NAME = 'ecommerce-api';
export const FRONTEND_REPOSITORY_NAME = 'ecommerce-frontend';

export interface EcrStackProps extends StackProps {
  /**
   * Account ids allowed to pull images - the environments' accounts. Same-account pulls need no
   * resource policy (the task execution role's identity policy covers them); each account listed
   * here gets `ecr:Pull` on both repositories so a different account's ECS service can pull.
   */
  readonly pullAccountIds: string[];
}

/**
 * The platform's shared container registry, deployed once per account rather than once per
 * environment.
 *
 * The registry is deliberately outside every environment stack: an image is a build artifact that
 * outlives any single environment, and promotion moves the *same* image forward instead of
 * rebuilding it. A shared registry is also why the image-build step needs no cross-account role -
 * it pushes with its own credentials and scoped permissions, and each environment's account is
 * granted pull through the repository's resource policy.
 *
 * Deploy ordering is unchanged: the repositories must exist before an image can be pushed, and an
 * image must exist before the compute stacks can start tasks.
 */
export class EcrStack extends Stack {
  /** The repository the application image is pushed to and pulled from. */
  public readonly repository: Repository;

  /** The repository the storefront image is pushed to and pulled from. */
  public readonly frontendRepository: Repository;

  /** RepositoryUri output, consumed by the pipeline's build step via envFromCfnOutputs. */
  public readonly repositoryUriOutput: CfnOutput;

  /** FrontendRepositoryUri output, exposed for the same reason. */
  public readonly frontendRepositoryUriOutput: CfnOutput;

  constructor(scope: Construct, id: string, props: EcrStackProps) {
    super(scope, id, props);

    this.repository = this.createRepository('Repository', API_REPOSITORY_NAME);
    this.frontendRepository = this.createRepository('FrontendRepository', FRONTEND_REPOSITORY_NAME);

    // Cross-account pull: the registry account grants each environment's account the pull actions
    // through the repositories' resource policies (grantPull is for roles; account principals need
    // an explicit resource-policy statement). The environment's task execution role carries the
    // matching identity-side permission - ECR authorization requires both sides when accounts differ.
    const pullAccounts = [...new Set(props.pullAccountIds)].map((account) => new AccountPrincipal(account));
    if (pullAccounts.length > 0) {
      const pullStatement = new PolicyStatement({
        effect: Effect.ALLOW,
        principals: pullAccounts,
        actions: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
      });
      this.repository.addToResourcePolicy(pullStatement);
      this.frontendRepository.addToResourcePolicy(pullStatement);
    }

    // The registry is shared infrastructure, so its tags name the platform rather than an
    // environment: it outlives any environment's teardown by design.
    Tags.of(this).add('Project', PROJECT_TAG);
    Tags.of(this).add('Environment', 'shared');
    Tags.of(this).add('ManagedBy', MANAGED_BY_TAG);

    this.repositoryUriOutput = new CfnOutput(this, 'RepositoryUri', {
      value: this.repository.repositoryUri,
      description: 'ECR repository to push the application image to',
      exportName: 'ecommerce-ecr-repository-uri',
    });

    new CfnOutput(this, 'RepositoryName', {
      value: this.repository.repositoryName,
      description: 'Name of the application image repository',
      exportName: 'ecommerce-ecr-repository-name',
    });

    this.frontendRepositoryUriOutput = new CfnOutput(this, 'FrontendRepositoryUri', {
      value: this.frontendRepository.repositoryUri,
      description: 'ECR repository to push the frontend image to',
      exportName: 'ecommerce-ecr-frontend-repository-uri',
    });

    new CfnOutput(this, 'FrontendRepositoryName', {
      value: this.frontendRepository.repositoryName,
      description: 'Name of the frontend image repository',
      exportName: 'ecommerce-ecr-frontend-repository-name',
    });
  }

  /**
   * Both repositories follow the same policy: scan on push, expire untagged, and retain on stack
   * deletion - deleting this stack must never silently destroy the images every environment pulls,
   * so the repositories survive and are emptied by hand if the registry is ever torn down.
   */
  private createRepository(id: string, repositoryName: string): Repository {
    return new Repository(this, id, {
      repositoryName,
      // Scan every pushed image for known vulnerabilities. Findings show up in ECR rather than in
      // the deployment path, so a vulnerable image is visible without blocking a rollout.
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          description: 'Expire untagged images',
          tagStatus: TagStatus.UNTAGGED,
          maxImageAge: UNTAGGED_IMAGE_MAX_AGE,
        },
      ],
    });
  }
}
