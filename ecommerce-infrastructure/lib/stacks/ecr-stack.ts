import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Repository, TagStatus } from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

import { EnvironmentConfig } from '../config/types';
import { applyPlatformTags } from '../tags';

/** Untagged images are build leftovers; they are expired rather than kept forever. */
const UNTAGGED_IMAGE_MAX_AGE = Duration.days(14);

export interface EcrStackProps extends StackProps {
  /** Environment specific configuration. No environment value is hardcoded in this stack. */
  readonly config: EnvironmentConfig;
}

/**
 * Container registry for the application image.
 *
 * The registry is a separate stack from the compute that runs it on purpose. An ECS service cannot
 * start until an image exists, and an image can only be pushed once the repository exists, so the
 * repository has to be creatable - and an image pushable - before the application stack is deployed.
 * Keeping the registry separate also means tearing down and recreating the compute never touches the
 * images, and the registry can be retained while everything else is disposable.
 */
export class EcrStack extends Stack {
  /** The repository the application image is pushed to and pulled from. */
  public readonly repository: Repository;

  /**
   * The repository the static frontend image is pushed to and pulled from. A separate repository
   * rather than a second tag in the API's: the two images have different lifecycles (the SPA is
   * rebuilt for every content or dependency change, the API for every code change) and are deployed
   * by different services.
   */
  public readonly frontendRepository: Repository;

  constructor(scope: Construct, id: string, props: EcrStackProps) {
    super(scope, id, props);

    const { config } = props;
    const exportPrefix = `ecommerce-${config.environment}`;

    this.repository = this.createRepository('Repository', `${exportPrefix}-api`, config);
    this.frontendRepository = this.createRepository('FrontendRepository', `${exportPrefix}-frontend`, config);

    applyPlatformTags(this, config);

    new CfnOutput(this, 'RepositoryUri', {
      value: this.repository.repositoryUri,
      description: 'ECR repository to push the container image to',
      exportName: `${exportPrefix}-ecr-repository-uri`,
    });

    new CfnOutput(this, 'RepositoryName', {
      value: this.repository.repositoryName,
      description: 'Name of the ECR repository',
      exportName: `${exportPrefix}-ecr-repository-name`,
    });

    new CfnOutput(this, 'FrontendRepositoryUri', {
      value: this.frontendRepository.repositoryUri,
      description: 'ECR repository to push the frontend image to',
      exportName: `${exportPrefix}-ecr-frontend-repository-uri`,
    });

    new CfnOutput(this, 'FrontendRepositoryName', {
      value: this.frontendRepository.repositoryName,
      description: 'Name of the frontend ECR repository',
      exportName: `${exportPrefix}-ecr-frontend-repository-name`,
    });
  }

  /** Both repositories follow the same policy: scan on push, expire untagged, follow the removal policy. */
  private createRepository(id: string, repositoryName: string, config: EnvironmentConfig): Repository {
    return new Repository(this, id, {
      repositoryName,
      // Scan every pushed image for known vulnerabilities. Findings show up in ECR rather than in
      // the deployment path, so a vulnerable image is visible without blocking a rollout.
      imageScanOnPush: true,
      removalPolicy: config.removalPolicy,
      // Emptying the repository on delete is only appropriate where the environment is disposable;
      // in uat and prod the images survive a `cdk destroy` along with the rest of the state.
      emptyOnDelete: config.removalPolicy === RemovalPolicy.DESTROY,
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
