import { Stack, StackProps } from 'aws-cdk-lib';
import { BuildSpec, ComputeType } from 'aws-cdk-lib/aws-codebuild';
import { PipelineType } from 'aws-cdk-lib/aws-codepipeline';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import {
  CodeBuildStep,
  CodePipeline,
  CodePipelineSource,
  ManualApprovalStep,
  ShellStep,
  Step,
} from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';

import { EnvironmentConfig } from '../config/types';
import { PlatformStage, SharedRegistryStage } from '../ecommerce-stage';
import { applyPlatformTags } from '../tags';
import {
  API_REPOSITORY_NAME,
  FRONTEND_REPOSITORY_NAME,
  RegistryLocation,
} from './ecr-stack';

/** The repository this pipeline builds and deploys. */
const SOURCE_REPOSITORY = 'lymengg/ecommerce-aws-cdk';
const SOURCE_BRANCH = 'main';

/** Node.js runtime every non-Java CodeBuild step runs on; package.json requires >= 22. */
const NODE_RUNTIME = { nodejs: '22' };
/** The API's toolchain: Java 21 per application/pom.xml, plus Node for the CDK. */
const JAVA_AND_NODE_RUNTIMES = { java: 'corretto21', nodejs: '22' };

const RUNTIME_BUILD_SPEC = (runtimeVersions: Record<string, string>) =>
  BuildSpec.fromObject({ version: '0.2', phases: { install: { 'runtime-versions': runtimeVersions } } });

export interface PipelineStackProps extends StackProps {
  /**
   * ARN of the CodeConnections connection to GitHub. The connection is created once by hand (the
   * OAuth handshake cannot be automated) and must be `Available`; the ARN is not a secret.
   */
  readonly connectionArn: string;

  /**
   * Where the shared container registry lives - the account and region this stack deploys to,
   * which is the account the pipeline runs in. The image build step pushes with its own scoped
   * credentials, so no cross-account role is needed on the push side; each environment's account is
   * granted pull through the repositories' resource policy instead.
   */
  readonly registry: RegistryLocation;

  /** Account ids allowed to pull images - every configured environment's account. */
  readonly pullAccountIds: string[];

  /**
   * `ECOMMERCE_*` variables forwarded into the synth build. `bin/pipeline.ts` collects whatever is
   * set locally so the pipeline synthesises exactly the configuration the deployer had - including
   * the dev NAT-gateway pause switch.
   */
  readonly synthEnvironment: Record<string, string>;

  /**
   * Environments to deploy, in promotion order: `dev` first (always present); `uat` and `prod` once
   * their `ECOMMERCE_<ENV>_ACCOUNT` and `ECOMMERCE_<ENV>_DOMAIN` variables are configured, each
   * gated by a manual approval. Resolved configurations rather than names, so the caller - not this
   * stack - decides which environments exist.
   */
  readonly environments: EnvironmentConfig[];
}

/**
 * Phase 8 CI/CD: a self-mutating CDK Pipeline that replaces the manual docker build / push /
 * `cdk deploy` flow.
 *
 * ```
 *   push to main -> Synth -> Tests -> registry -> dev -> [approval] uat -> [approval] prod
 *                                        |__ BuildImages runs before the first environment
 * ```
 *
 * The registry is a single shared stage (one repository pair for every environment - an image is a
 * build artifact, not an environment resource), which is what makes the pipeline promote rather
 * than rebuild: `IMAGE_TAG` is the commit SHA at both ends - synth bakes it into the task
 * definitions, the build step pushes it - and `CODEBUILD_RESOLVED_SOURCE_VERSION` is the same
 * commit in every action of one execution, so dev, uat and prod all run the identical image.
 *
 * Credentials: none are stored. The source rides a CodeConnections connection; deploys assume the
 * bootstrap roles; the image push uses the step's own role scoped to the two repositories; pulls
 * from other accounts are granted by the repositories' resource policy.
 */
export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const source = CodePipelineSource.connection(SOURCE_REPOSITORY, SOURCE_BRANCH, {
      connectionArn: props.connectionArn,
      triggerOnPush: true,
    });

    const pipeline = new CodePipeline(this, 'Pipeline', {
      pipelineName: 'ecommerce-platform',
      // V2 is the modern pipeline type: variables, triggers and a different (cheaper) billing model
      // than the legacy V1 default the construct would otherwise pick with a warning.
      pipelineType: PipelineType.V2,
      // The KMS key on the artifact bucket is what lets deploy actions in another account read the
      // cloud assembly - required for the uat/prod cross-account path even though dev is same
      // account today. (It is also the default; this documents why it must stay on.)
      crossAccountKeys: true,
      // The pipeline re-synthesises and updates itself on every push, so changes to this file do
      // not need a manual `cdk deploy` of the pipeline stack.
      selfMutation: true,
      synth: new ShellStep('Synth', {
        input: source,
        env: props.synthEnvironment,
        commands: [
          'cd ecommerce-infrastructure',
          'npm ci',
          // The image tag is the commit SHA: immutable, and identical to the tag the build step
          // pushes below.
          'export IMAGE_TAG="$CODEBUILD_RESOLVED_SOURCE_VERSION"',
          'npx cdk --app "npx ts-node --prefer-ts-exts bin/pipeline.ts" synth --strict',
        ],
        primaryOutputDirectory: 'ecommerce-infrastructure/cdk.out',
      }),
      synthCodeBuildDefaults: { partialBuildSpec: RUNTIME_BUILD_SPEC(NODE_RUNTIME) },
      codeBuildDefaults: { partialBuildSpec: RUNTIME_BUILD_SPEC(NODE_RUNTIME) },
    });

    // Unit tests gate the first deploy of the run. Three independent toolchains, three steps that
    // fail the pipeline before any infrastructure is touched.
    const tests: Step[] = [
      new CodeBuildStep('InfrastructureTests', {
        input: source,
        commands: ['cd ecommerce-infrastructure', 'npm ci', 'npm run typecheck', 'npm test'],
      }),
      new CodeBuildStep('FrontendTests', {
        input: source,
        commands: ['cd frontend', 'npm ci', 'npm run typecheck', 'npm test'],
      }),
      new CodeBuildStep('ApiTests', {
        input: source,
        // Docker-in-Docker: the API test suite runs PostgreSQL through Testcontainers.
        buildEnvironment: { privileged: true, computeType: ComputeType.MEDIUM },
        partialBuildSpec: RUNTIME_BUILD_SPEC(JAVA_AND_NODE_RUNTIMES),
        commands: ['cd application', 'mvn -B -ntp test'],
      }),
    ];

    const sharedRegistry = new SharedRegistryStage(this, 'registry', {
      registry: props.registry,
      pullAccountIds: props.pullAccountIds,
    });
    pipeline.addStage(sharedRegistry, { pre: tests });

    // Built once per run - the identical images are what every environment deploys. The frontend
    // needs no per-environment build because the SPA resolves its API origin at runtime.
    const repositoryArn = (name: string) =>
      `arn:aws:ecr:${props.registry.region}:${props.registry.account}:repository/${name}`;
    const buildImages = new CodeBuildStep('BuildImages', {
      input: source,
      // Privileged mode gives the step a Docker daemon for `docker build`.
      buildEnvironment: { privileged: true, computeType: ComputeType.MEDIUM },
      env: { REGION: props.registry.region },
      envFromCfnOutputs: {
        API_REPO_URI: sharedRegistry.registry.repositoryUriOutput,
        FRONTEND_REPO_URI: sharedRegistry.registry.frontendRepositoryUriOutput,
      },
      // The push uses the step's own role - the registry is in the pipeline's account, so no role
      // assumption is needed; the statements below are the whole of what the step can do.
      rolePolicyStatements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['ecr:GetAuthorizationToken'],
          resources: ['*'],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'ecr:BatchCheckLayerAvailability',
            'ecr:CompleteLayerUpload',
            'ecr:InitiateLayerUpload',
            'ecr:PutImage',
            'ecr:UploadLayerPart',
          ],
          resources: [repositoryArn(API_REPOSITORY_NAME), repositoryArn(FRONTEND_REPOSITORY_NAME)],
        }),
      ],
      commands: [
        'export IMAGE_TAG="$CODEBUILD_RESOLVED_SOURCE_VERSION"',
        'aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${API_REPO_URI%%/*}"',
        'docker build -t "$API_REPO_URI:$IMAGE_TAG" application',
        'docker build -t "$FRONTEND_REPO_URI:$IMAGE_TAG" frontend',
        'docker push "$API_REPO_URI:$IMAGE_TAG"',
        'docker push "$FRONTEND_REPO_URI:$IMAGE_TAG"',
      ],
    });

    props.environments.forEach((config, index) => {
      const environment = config.environment;
      const env = { account: config.account, region: config.region };
      // config.dns is guaranteed by the platform stage's own validation (auth requires a domain).
      const domain = config.dns!.zoneName;

      // The first environment builds and pushes the images; every later environment is gated by a
      // human approval - dev deploys on merge, uat and prod only after someone approves the
      // promotion. Images are already built by then: promotion deploys the identical artifact.
      const gate: Step[] =
        index === 0 ? [buildImages] : [new ManualApprovalStep(`Promote to ${environment}`)];

      const platform = new PlatformStage(this, environment, { env, config, registry: props.registry });
      pipeline.addStage(platform, {
        // Images must exist before the compute stacks roll: the task definitions reference the
        // tag built here, and a service that cannot pull never becomes healthy.
        pre: gate,
        post: [this.smokeTests(environment, domain)],
      });
    });

    applyPlatformTags(this, props.environments[0]);
  }

  /**
   * Post-deploy checks against the live endpoints: the API health endpoint, an anonymous write
   * (which must be 401, not a redirect), a public read, the SPA apex and the managed login page -
   * the same set PAUSE-RESUME.md verifies by hand.
   */
  private smokeTests(environment: string, domain: string): Step {
    const expect = (url: string, status: number, extra = '') =>
      `test "$(curl -s -o /dev/null -w '%{http_code}' ${extra} --retry 12 --retry-delay 15 --retry-all-errors ${url})" = "${status}" || { echo "FAIL: ${url} did not answer ${status}"; exit 1; }`;

    return new CodeBuildStep(`SmokeTests-${environment}`, {
      env: { DOMAIN: domain },
      commands: [
        expect(`https://api.$DOMAIN/actuator/health`, 200),
        expect(`https://api.$DOMAIN/api/products`, 200),
        // Anonymous writes are rejected outright: authenticated but non-admin callers get 403.
        expect(`https://api.$DOMAIN/api/products`, 401, '-X POST'),
        expect(`https://$DOMAIN`, 200),
        expect(`https://auth.$DOMAIN/login`, 200),
        `echo "Smoke tests passed for ${environment}"`,
      ],
    });
  }
}
