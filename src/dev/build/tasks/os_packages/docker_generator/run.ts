/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import { access, link, unlink, chmod } from 'fs';
import { resolve } from 'path';
import { promisify } from 'util';

import { ToolingLog, kibanaPackageJson } from '@kbn/dev-utils';

import { write, copyAll, mkdirp, exec, Config, Build } from '../../../lib';
import * as dockerTemplates from './templates';
import { TemplateContext } from './template_context';
import { bundleDockerFiles } from './bundle_dockerfiles';

const accessAsync = promisify(access);
const linkAsync = promisify(link);
const unlinkAsync = promisify(unlink);
const chmodAsync = promisify(chmod);

export async function runDockerGenerator(
  config: Config,
  log: ToolingLog,
  build: Build,
  flags: {
    architecture?: string;
    context: boolean;
    image: boolean;
    ubi?: boolean;
    ironbank?: boolean;
    dockerBuildDate?: string;
  }
) {
  // UBI var config
  const baseOSImage = flags.ubi ? 'docker.elastic.co/ubi8/ubi-minimal:latest' : 'centos:8';
  const ubiVersionTag = 'ubi8';

  let imageFlavor = '';
  if (flags.ubi) imageFlavor += `-${ubiVersionTag}`;
  if (flags.ironbank) imageFlavor += '-ironbank';

  // General docker var config
  const license = 'Elastic License';
  const imageTag = 'docker.elastic.co/kibana/kibana';
  const version = config.getBuildVersion();
  const artifactArchitecture = flags.architecture === 'aarch64' ? 'aarch64' : 'x86_64';
  const artifactPrefix = `kibana-${version}-linux`;
  const artifactTarball = `${artifactPrefix}-${artifactArchitecture}.tar.gz`;
  const artifactsDir = config.resolveFromTarget('.');
  const dockerBuildDate = flags.dockerBuildDate || new Date().toISOString();
  // That would produce oss, default and default-ubi7
  const dockerBuildDir = config.resolveFromRepo('build', 'kibana-docker', `default${imageFlavor}`);
  const imageArchitecture = flags.architecture === 'aarch64' ? '-aarch64' : '';
  const dockerTargetFilename = config.resolveFromTarget(
    `kibana${imageFlavor}-${version}-docker-image${imageArchitecture}.tar.gz`
  );
  const scope: TemplateContext = {
    artifactPrefix,
    artifactTarball,
    imageFlavor,
    version,
    branch: kibanaPackageJson.branch,
    license,
    artifactsDir,
    imageTag,
    dockerBuildDir,
    dockerTargetFilename,
    baseOSImage,
    dockerBuildDate,
    ubi: flags.ubi,
    ironbank: flags.ironbank,
    architecture: flags.architecture,
    revision: config.getBuildSha(),
  };

  type HostArchitectureToDocker = Record<string, string>;
  const hostTarget: HostArchitectureToDocker = {
    x64: 'x64',
    arm64: 'aarch64',
  };
  const buildArchitectureSupported = hostTarget[process.arch] === flags.architecture;
  if (flags.architecture && !buildArchitectureSupported) {
    return;
  }

  // Verify if we have the needed kibana target in order
  // to build the kibana docker image.
  // Also create the docker build target folder
  // and  delete the current linked target into the
  // kibana docker build folder if we have one.
  try {
    await accessAsync(resolve(artifactsDir, artifactTarball));
    await mkdirp(dockerBuildDir);
    await unlinkAsync(resolve(dockerBuildDir, artifactTarball));
  } catch (e) {
    if (e && e.code === 'ENOENT' && e.syscall === 'access') {
      throw new Error(
        `Kibana linux target (${artifactTarball}) is needed in order to build ${''}the docker image. None was found at ${artifactsDir}`
      );
    }
  }

  // Create the kibana linux target inside the
  // Kibana docker build
  await linkAsync(resolve(artifactsDir, artifactTarball), resolve(dockerBuildDir, artifactTarball));

  // Write all the needed docker config files
  // into kibana-docker folder
  for (const [, dockerTemplate] of Object.entries(dockerTemplates)) {
    await write(resolve(dockerBuildDir, dockerTemplate.name), dockerTemplate.generator(scope));
  }

  // Copy all the needed resources into kibana-docker folder
  // in order to build the docker image accordingly the dockerfile defined
  // under templates/kibana_yml.template/js
  await copyAll(
    config.resolveFromRepo('src/dev/build/tasks/os_packages/docker_generator/resources/base'),
    dockerBuildDir
  );

  if (flags.ironbank) {
    await copyAll(
      config.resolveFromRepo('src/dev/build/tasks/os_packages/docker_generator/resources/ironbank'),
      dockerBuildDir
    );
  }

  // Build docker image into the target folder
  // In order to do this we just call the file we
  // created from the templates/build_docker_sh.template.js
  // and we just run that bash script
  await chmodAsync(`${resolve(dockerBuildDir, 'build_docker.sh')}`, '755');

  // Only build images on native targets
  if (flags.image) {
    await exec(log, `./build_docker.sh`, [], {
      cwd: dockerBuildDir,
      level: 'info',
    });
  }

  // Pack Dockerfiles and create a target for them
  if (flags.context) {
    await bundleDockerFiles(config, log, scope);
  }
}
