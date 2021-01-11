/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neil Enns. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as log from "../../Log";
import Trigger from "../../Trigger";

import mkdirp from "mkdirp";
import path from "path";
import { promises as fsPromise } from "fs";

import IDeepStackPrediction from "../../types/IDeepStackPrediction";
import * as LocalStorageManager from "../../LocalStorageManager";

export async function initialize(): Promise<void> {
  await mkdirp(path.join(LocalStorageManager.localStoragePath, "archive"));
}

export async function removeFile(fileName: string, trigger: Trigger): Promise<void[]> {
  // It's possible to not set up a web request handler on a trigger or to disable it, so don't
  // process if that's the case.
  if (!trigger?.archiveConfig?.enabled) {
    return [];
  }

  return Promise.all(getFiles(fileName).map(f => remove(f)));
}

/**
 * Handles calling a list of web URLs.
 */
export async function processTrigger(
  fileName: string,
  trigger: Trigger,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  predictions: IDeepStackPrediction[],
): Promise<void[]> {
  // It's possible to not set up a web request handler on a trigger or to disable it, so don't
  // process if that's the case.
  if (!trigger?.archiveConfig?.enabled) {
    return [];
  }
  return Promise.all(getFiles(fileName).map(f => move(f)));
}

function getFiles(fileName: string): string[] {
  const movieFileName = `${path.join(path.dirname(fileName), path.basename(fileName, path.extname(fileName)))}.mp4`;
  return [fileName, movieFileName];
}

async function move(file: string): Promise<void> {
  log.verbose("Archiver", `coping ${file}`);

  const localFileName = path.join(LocalStorageManager.localStoragePath, "Archive", path.basename(file));
  await fsPromise.copyFile(file, localFileName).then(
    () => {
      fsPromise.unlink(file).catch(e => log.warn("Archiver", `Unable to remove file: ${e.message}`));
    },
    e => {
      log.warn("Archiver", `Unable to copy to local storage: ${e.message}`);
    },
  );
}

async function remove(file: string): Promise<void> {
  log.verbose("Archiver", `remove ${file}`);
  await fsPromise.unlink(file).catch(e => log.warn("Archiver", `Unable to remove file: ${e.message}`));
}
