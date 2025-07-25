import { prompt } from 'enquirer';
import { rmSync } from 'node:fs';
import { NxReleaseConfiguration, readNxJson } from '../../config/nx-json';
import { createProjectFileMapUsingProjectGraph } from '../../project-graph/file-map-utils';
import { createProjectGraphAsync } from '../../project-graph/project-graph';
import { handleErrors } from '../../utils/handle-errors';
import { output } from '../../utils/output';
import { createAPI as createReleaseChangelogAPI } from './changelog';
import { ReleaseOptions, VersionOptions } from './command-object';
import {
  IMPLICIT_DEFAULT_RELEASE_GROUP,
  NxReleaseConfig,
  ResolvedCreateRemoteReleaseProvider,
  createNxReleaseConfig,
  handleNxReleaseConfigError,
} from './config/config';
import { deepMergeJson } from './config/deep-merge-json';
import { filterReleaseGroups } from './config/filter-release-groups';
import { shouldUseLegacyVersioning } from './config/use-legacy-versioning';
import {
  readRawVersionPlans,
  setResolvedVersionPlansOnGroups,
} from './config/version-plans';
import { createAPI as createReleasePublishAPI } from './publish';
import { getCommitHash, gitAdd, gitCommit, gitPush, gitTag } from './utils/git';
import { printConfigAndExit } from './utils/print-config';
import { createRemoteReleaseClient } from './utils/remote-release-clients/remote-release-client';
import { resolveNxJsonConfigErrorMessage } from './utils/resolve-nx-json-error-message';
import {
  createCommitMessageValues,
  createGitTagValues,
  handleDuplicateGitTags,
} from './utils/shared';
import {
  NxReleaseVersionResult,
  createAPI as createReleaseVersionAPI,
} from './version';

export const releaseCLIHandler = (args: VersionOptions) =>
  handleErrors(args.verbose, () => createAPI({})(args));

export function createAPI(overrideReleaseConfig: NxReleaseConfiguration) {
  const releaseVersion = createReleaseVersionAPI(overrideReleaseConfig);
  const releaseChangelog = createReleaseChangelogAPI(overrideReleaseConfig);
  const releasePublish = createReleasePublishAPI(overrideReleaseConfig);

  return async function release(
    args: ReleaseOptions
  ): Promise<NxReleaseVersionResult | number> {
    const projectGraph = await createProjectGraphAsync({ exitOnError: true });
    const nxJson = readNxJson();
    const userProvidedReleaseConfig = deepMergeJson(
      nxJson.release ?? {},
      overrideReleaseConfig ?? {}
    );

    const hasVersionGitConfig =
      Object.keys(userProvidedReleaseConfig.version?.git ?? {}).length > 0;
    const hasChangelogGitConfig =
      Object.keys(userProvidedReleaseConfig.changelog?.git ?? {}).length > 0;
    if (hasVersionGitConfig || hasChangelogGitConfig) {
      const jsonConfigErrorPath = hasVersionGitConfig
        ? ['release', 'version', 'git']
        : ['release', 'changelog', 'git'];
      const nxJsonMessage = await resolveNxJsonConfigErrorMessage(
        jsonConfigErrorPath
      );
      output.error({
        title: `The "release" top level command cannot be used with granular git configuration. Instead, configure git options in the "release.git" property in nx.json, or use the version, changelog, and publish subcommands or programmatic API directly.`,
        bodyLines: [nxJsonMessage],
      });
      process.exit(1);
    }

    // Apply default configuration to any optional user configuration
    const { error: configError, nxReleaseConfig } = await createNxReleaseConfig(
      projectGraph,
      await createProjectFileMapUsingProjectGraph(projectGraph),
      userProvidedReleaseConfig
    );
    if (configError) {
      const USE_LEGACY_VERSIONING = shouldUseLegacyVersioning(
        userProvidedReleaseConfig
      );
      return await handleNxReleaseConfigError(
        configError,
        USE_LEGACY_VERSIONING
      );
    }
    // --print-config exits directly as it is not designed to be combined with any other programmatic operations
    if (args.printConfig) {
      return printConfigAndExit({
        userProvidedReleaseConfig,
        nxReleaseConfig,
        isDebug: args.printConfig === 'debug',
      });
    }

    const {
      error: filterError,
      filterLog,
      releaseGroups,
      releaseGroupToFilteredProjects,
    } = filterReleaseGroups(
      projectGraph,
      nxReleaseConfig,
      args.projects,
      args.groups
    );
    if (filterError) {
      output.error(filterError);
      process.exit(1);
    }
    if (filterLog) {
      output.note(filterLog);
    }
    // Do not repeat the filter log in the release subcommands
    process.env.NX_RELEASE_INTERNAL_SUPPRESS_FILTER_LOG = 'true';

    const rawVersionPlans = await readRawVersionPlans();

    if (args.specifier && rawVersionPlans.length > 0) {
      output.error({
        title: `A specifier option cannot be provided when using version plans.`,
        bodyLines: [
          `To override this behavior, use the Nx Release programmatic API directly (https://nx.dev/features/manage-releases#using-the-programmatic-api-for-nx-release).`,
        ],
      });
      process.exit(1);
    }

    // These properties must never be undefined as this command should
    // always explicitly override the git operations of the subcommands.
    const shouldCommit = userProvidedReleaseConfig.git?.commit ?? true;
    const shouldStage =
      (shouldCommit || userProvidedReleaseConfig.git?.stageChanges) ?? false;
    const shouldTag = userProvidedReleaseConfig.git?.tag ?? true;

    const shouldCreateWorkspaceRemoteRelease = shouldCreateRemoteRelease(
      nxReleaseConfig.changelog.workspaceChangelog
    );
    // If the workspace or any of the release groups specify that a remote release should be created, we need to push the changes to the remote
    const shouldPush =
      (shouldCreateWorkspaceRemoteRelease ||
        releaseGroups.some((group) =>
          shouldCreateRemoteRelease(group.changelog)
        )) ??
      false;

    const versionResult: NxReleaseVersionResult = await releaseVersion({
      ...args,
      stageChanges: shouldStage,
      gitCommit: false,
      gitTag: false,
      deleteVersionPlans: false,
    });

    const changelogResult = await releaseChangelog({
      ...args,
      versionData: versionResult.projectsVersionData,
      version: versionResult.workspaceVersion,
      stageChanges: shouldStage,
      gitCommit: false,
      gitTag: false,
      gitPush: false,
      createRelease: false,
      deleteVersionPlans: false,
    });

    await setResolvedVersionPlansOnGroups(
      rawVersionPlans,
      releaseGroups,
      Object.keys(projectGraph.nodes),
      args.verbose
    );

    const planFiles = new Set<string>();
    releaseGroups.forEach((group) => {
      if (group.resolvedVersionPlans) {
        if (group.name === IMPLICIT_DEFAULT_RELEASE_GROUP) {
          output.logSingleLine(`Removing version plan files`);
        } else {
          output.logSingleLine(
            `Removing version plan files for group ${group.name}`
          );
        }
        group.resolvedVersionPlans.forEach((plan) => {
          if (!args.dryRun) {
            rmSync(plan.absolutePath, { recursive: true, force: true });
            if (args.verbose) {
              console.log(`Removing ${plan.relativePath}`);
            }
          } else {
            if (args.verbose) {
              console.log(
                `Would remove ${plan.relativePath}, but --dry-run was set`
              );
            }
          }
          planFiles.add(plan.relativePath);
        });
      }
    });
    const deletedFiles = Array.from(planFiles);
    if (deletedFiles.length > 0) {
      await gitAdd({
        changedFiles: [],
        deletedFiles,
        dryRun: args.dryRun,
        verbose: args.verbose,
      });
    }

    if (shouldCommit) {
      output.logSingleLine(`Committing changes with git`);

      const commitMessage: string | undefined =
        nxReleaseConfig.git.commitMessage;

      const commitMessageValues: string[] = createCommitMessageValues(
        releaseGroups,
        releaseGroupToFilteredProjects,
        versionResult.projectsVersionData,
        commitMessage
      );

      await gitCommit({
        messages: commitMessageValues,
        additionalArgs: nxReleaseConfig.git.commitArgs,
        dryRun: args.dryRun,
        verbose: args.verbose,
      });
    }

    if (shouldTag) {
      output.logSingleLine(`Tagging commit with git`);

      // Resolve any git tags as early as possible so that we can hard error in case of any duplicates before reaching the actual git command
      const gitTagValues: string[] = createGitTagValues(
        releaseGroups,
        releaseGroupToFilteredProjects,
        versionResult.projectsVersionData
      );
      handleDuplicateGitTags(gitTagValues);

      for (const tag of gitTagValues) {
        await gitTag({
          tag,
          message: nxReleaseConfig.git.tagMessage,
          additionalArgs: nxReleaseConfig.git.tagArgs,
          dryRun: args.dryRun,
          verbose: args.verbose,
        });
      }
    }

    let hasPushedChanges = false;
    if (shouldPush) {
      output.logSingleLine(`Pushing to git remote "origin"`);
      await gitPush({
        dryRun: args.dryRun,
        verbose: args.verbose,
        additionalArgs: nxReleaseConfig.git.pushArgs,
      });
      hasPushedChanges = true;
    }

    let latestCommit: string | undefined;

    if (
      shouldCreateWorkspaceRemoteRelease &&
      changelogResult.workspaceChangelog
    ) {
      const remoteReleaseClient = await createRemoteReleaseClient(
        // shouldCreateWorkspaceRemoteRelease() ensures that the createRelease property exists and is not false
        (nxReleaseConfig.changelog.workspaceChangelog as any)
          .createRelease as ResolvedCreateRemoteReleaseProvider
      );
      if (!hasPushedChanges) {
        throw new Error(
          `It is not possible to create a ${remoteReleaseClient.remoteReleaseProviderName} release for the workspace without pushing the changes to the remote, please ensure that you have not disabled git push in your nx release config`
        );
      }

      output.logSingleLine(
        `Creating ${remoteReleaseClient.remoteReleaseProviderName} Release`
      );

      latestCommit = await getCommitHash('HEAD');

      await remoteReleaseClient.createOrUpdateRelease(
        changelogResult.workspaceChangelog.releaseVersion,
        changelogResult.workspaceChangelog.contents,
        latestCommit,
        { dryRun: args.dryRun }
      );
    }

    for (const releaseGroup of releaseGroups) {
      const shouldCreateProjectRemoteReleases = shouldCreateRemoteRelease(
        releaseGroup.changelog
      );
      if (
        shouldCreateProjectRemoteReleases &&
        changelogResult.projectChangelogs
      ) {
        const remoteReleaseClient = await createRemoteReleaseClient(
          // shouldCreateProjectRemoteReleases() ensures that the createRelease property exists and is not false
          (releaseGroup.changelog as any)
            .createRelease as ResolvedCreateRemoteReleaseProvider
        );

        const projects = args.projects?.length
          ? // If the user has passed a list of projects, we need to use the filtered list of projects within the release group
            Array.from(releaseGroupToFilteredProjects.get(releaseGroup))
          : // Otherwise, we use the full list of projects within the release group
            releaseGroup.projects;
        const projectNodes = projects.map((name) => projectGraph.nodes[name]);

        for (const project of projectNodes) {
          const changelog = changelogResult.projectChangelogs[project.name];
          if (!changelog) {
            continue;
          }

          if (!hasPushedChanges) {
            throw new Error(
              `It is not possible to create a ${remoteReleaseClient.remoteReleaseProviderName} release for the project without pushing the changes to the remote, please ensure that you have not disabled git push in your nx release config`
            );
          }

          output.logSingleLine(
            `Creating ${remoteReleaseClient.remoteReleaseProviderName} Release`
          );

          if (!latestCommit) {
            latestCommit = await getCommitHash('HEAD');
          }

          await remoteReleaseClient.createOrUpdateRelease(
            changelog.releaseVersion,
            changelog.contents,
            latestCommit,
            { dryRun: args.dryRun }
          );
        }
      }
    }

    let hasNewVersion = false;
    // null means that all projects are versioned together but there were no changes
    if (versionResult.workspaceVersion !== null) {
      hasNewVersion = Object.values(versionResult.projectsVersionData).some(
        (version) =>
          /**
           * There is a scenario where applications will not have a newVersion created by VerisonActions,
           * however, there will still be a dockerVersion created from the docker release.
           */

          version.newVersion !== null || version.dockerVersion !== null
      );
    }

    let shouldPublish = !!args.yes && !args.skipPublish && hasNewVersion;
    const shouldPromptPublishing =
      !args.yes && !args.skipPublish && !args.dryRun && hasNewVersion;

    if (shouldPromptPublishing) {
      shouldPublish = await promptForPublish();
    }

    if (shouldPublish) {
      const publishResults = await releasePublish(args);
      const allExitOk = Object.values(publishResults).every(
        (result) => result.code === 0
      );
      if (!allExitOk) {
        // When a publish target fails, we want to fail the nx release CLI
        process.exit(1);
      }
    } else {
      output.logSingleLine('Skipped publishing packages.');
    }

    return versionResult;
  };
}

async function promptForPublish(): Promise<boolean> {
  try {
    const reply = await prompt<{ confirmation: boolean }>([
      {
        name: 'confirmation',
        message: 'Do you want to publish these versions?',
        type: 'confirm',
      },
    ]);
    return reply.confirmation;
  } catch {
    // Ensure the cursor is always restored before exiting
    process.stdout.write('\u001b[?25h');
    // Handle the case where the user exits the prompt with ctrl+c
    return false;
  }
}

function shouldCreateRemoteRelease(
  changelogConfig:
    | NxReleaseConfig['changelog']['workspaceChangelog']
    | NxReleaseConfig['changelog']['projectChangelogs']
    | NxReleaseConfig['groups'][number]['changelog']
): boolean {
  if (changelogConfig === false) {
    return false;
  }
  return changelogConfig.createRelease !== false;
}
