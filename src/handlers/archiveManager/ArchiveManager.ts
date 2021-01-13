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
import { TriggerFlags } from "../..//triggerFlags";

type Element = {
  action: string;
  file: string;
  attempt: number;
  success: boolean;
  folder: string;
};

export default class ArchiveManager {
  private static archiverLog: Element[];
  private static _backgroundTimer: NodeJS.Timeout;

  private static readonly ArchiveFolder = "archive";
  private static readonly SemiMatchedFolder = "maybeMatched";

  public static stopBackgroundArchiving(): void {
    clearTimeout(ArchiveManager._backgroundTimer);
    log.verbose("ArchiveManager", `Background archive stopped.`);
  }

  static async shutDown(): Promise<void> {
    ArchiveManager.stopBackgroundArchiving()
    return ArchiveManager.runLog();
  }

  public static async initialize(): Promise<void> {
    await mkdirp(path.join(LocalStorageManager.localStoragePath, ArchiveManager.ArchiveFolder));
    await mkdirp(path.join(LocalStorageManager.localStoragePath, ArchiveManager.SemiMatchedFolder));
    ArchiveManager.archiverLog = [];
    ArchiveManager.runLog();
    log.verbose("ArchiveManager", `Archiver initialized.`);
  }

  public static async removeFile(fileName: string, trigger: Trigger): Promise<void[]> {
    // It's possible to not set up a web request handler on a trigger or to disable it, so don't
    // process if that's the case.
    if (!trigger?.archiveConfig?.enabled) {
      return [];
    }

    return Promise.all(ArchiveManager.getFiles(fileName).map(f => ArchiveManager.markFileForAction(f, 'remove')));
  }

  /**
   * Handles calling a list of web URLs.
   */
  public static async processTrigger(
    fileName: string,
    trigger: Trigger,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    predictions: IDeepStackPrediction[],
    predictionsWithFlags?: { prediction: IDeepStackPrediction, triggeredFlags: TriggerFlags }[],
  ): Promise<void[]> {
    // It's possible to not set up a web request handler on a trigger or to disable it, so don't
    // process if that's the case.
    if (!trigger?.archiveConfig?.enabled) {
      return [];
    }
    const folder = predictionsWithFlags && predictionsWithFlags.filter(f => f.triggeredFlags.registered && f.triggeredFlags.confidenceThresholdMet)
      ? ArchiveManager.SemiMatchedFolder
      : ArchiveManager.ArchiveFolder;
    return Promise.all(ArchiveManager.getFiles(fileName).map(f => ArchiveManager.markFileForAction(f, 'move', folder)));
  }

  public static async runLog(): Promise<void> {
    ArchiveManager.archiverLog = ArchiveManager.archiverLog || [];
    const result = Promise.all(ArchiveManager.archiverLog.map(element => {
      element.attempt++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (<Promise<void>>(<any>ArchiveManager)[element.action](element));
    })).then(() => {
      ArchiveManager.archiverLog = ArchiveManager.archiverLog.filter(e => !e.success && e.attempt <= 3);
    });

    ArchiveManager._backgroundTimer = setTimeout(ArchiveManager.runLog, 60000);

    return result;
  }

  static getFiles(fileName: string): string[] {
    const movieFileName = `${path.join(path.dirname(fileName), path.basename(fileName, path.extname(fileName)))}.mp4`;
    const fileNameWithoutIndex = path.basename(fileName).substring(0, path.basename(fileName).length - 7);
    const fileNameIndex = parseInt(fileName.substr(-7).substring(0, 3)) - 1;
    const movieFileNameIndexed = `${path.join(path.dirname(fileName), fileNameWithoutIndex)}${('000000000' + fileNameIndex).substr(-3)}.mp4`;
    return [fileName, movieFileName, movieFileNameIndexed];
  }

  static markFileForAction(fileName: string, action: string, folder?: string): void {
    ArchiveManager.archiverLog.push({ action: action, file: fileName, attempt: 0, success: false, folder: folder });
  }

  static async move(element: Element): Promise<void> {
    const file = element.file;
    log.verbose("Archiver", `coping ${file}, attempt: ${element.attempt}`);

    const localFileName = path.join(LocalStorageManager.localStoragePath, element.folder || ArchiveManager.ArchiveFolder, path.basename(file));
    await fsPromise.copyFile(file, localFileName).then(
      () => { element.action = 'remove'; ArchiveManager.remove(element); },
      e => { log.warn("Archiver", `Unable to copy to local storage: ${e.message}`); },
    );
  }

  static async remove(file: Element): Promise<void> {
    log.verbose("Archiver", `remove ${file.file}, attempt: ${file.attempt}`);
    await fsPromise.unlink(file.file).then(() => file.success = true, e => log.warn("Archiver", `Unable to remove file: ${e.message}`));
  }
}
