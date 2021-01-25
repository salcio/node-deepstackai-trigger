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
import ArchiveConfig from "./ArchiveManagerConfig";
import moment from "moment";

type Element = {
  action: string;
  file: string;
  attempt: number;
  success: boolean;
  folder: string;
  dateAdded: Date;
  dateToArchive: Date;
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

  public static async removeFile(fileName: string, trigger: Trigger): Promise<void> {
    // It's possible to not set up a web request handler on a trigger or to disable it, so don't
    // process if that's the case.
    if (!trigger?.archiveConfig?.enabled) {
      return null;
    }

    return ArchiveManager.markFileForAction(fileName, 'remove', trigger.archiveConfig);
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
  ): Promise<void> {
    // It's possible to not set up a web request handler on a trigger or to disable it, so don't
    // process if that's the case.
    if (!trigger?.archiveConfig?.enabled) {
      return null;
    }
    let folder = ArchiveManager.ArchiveFolder;
    if (predictionsWithFlags) {
      if (trigger.archiveConfig.semiMatchedArchiveEnabled && predictionsWithFlags.filter(f => f.triggeredFlags.registered && f.triggeredFlags.confidenceThresholdMet).length > 0) {
        log.verbose("Archiver", `semi matched file ${fileName}. Adding to archive log.`);
        folder = ArchiveManager.SemiMatchedFolder
      } else {
        return ArchiveManager.removeFile(fileName, trigger);
      }
    }
    return ArchiveManager.markFileForAction(fileName, 'move', trigger.archiveConfig, folder);
  }

  public static async runLog(): Promise<void> {
    ArchiveManager.archiverLog = ArchiveManager.archiverLog || [];
    const result = Promise.all(ArchiveManager.archiverLog.map(element => {
      if (!ArchiveManager.canAction(element)) {
        return;
      }
      element.attempt++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (<Promise<void>>(<any>ArchiveManager)[element.action](element));
    })).then(() => {
      ArchiveManager.archiverLog = ArchiveManager.archiverLog.filter(e => !e.success && e.attempt <= 3);
    });

    ArchiveManager._backgroundTimer = setTimeout(ArchiveManager.runLog, 6000);

    return result;
  }

  static async getFiles(fileName: string): Promise<string[]> {
    const fileBaseName = path.basename(fileName);
    const lastUnderscoreIndex = fileBaseName.lastIndexOf('_');
    const fileNameBase = `${path.join(path.dirname(fileName), fileBaseName.substring(0, lastUnderscoreIndex + 1))}`;
    const fileNameDateString = fileBaseName.substring(lastUnderscoreIndex + 1, fileBaseName.length - 4);
    const fileNameDateStart = moment(fileNameDateString, "YYYYMMDDHHmmss").add(-3, "seconds");
    const filePromises = Array.from(Array<number>(4).keys())
      .map(() => {
        const r = `${fileNameBase}${fileNameDateStart.add(1, "seconds").format("YYYYMMDDHHmmss")}.mp4`;
        return fsPromise.stat(r).then(s => { return s.isFile() ? r : null; }).catch(() => { return null });
      });

    return [fileName,
      ...(await Promise.all(filePromises)).filter(r => r != null)
    ];
  }

  static markFileForAction(fileName: string, action: string, config: ArchiveConfig, folder?: string,): void {
    const existing = ArchiveManager.archiverLog.filter(e => e.file == fileName && e.folder == folder)[0];
    if (!existing) {
      ArchiveManager.archiverLog.push({ action: action, file: fileName, attempt: 0, success: false, folder: folder, dateAdded: new Date(), dateToArchive: new Date(new Date().getTime() + config.timeToKeep) });
    }
    else {
      if (existing.action == "remove") {
        existing.action = action;
        existing.attempt = 0;
        existing.dateAdded = new Date();
        existing.dateToArchive = new Date(new Date().getTime() + config.timeToKeep);
      }
    }
  }

  static async move(element: Element): Promise<void[]> {
    if (!ArchiveManager.canAction(element)) {
      return;
    }

    return Promise.all((await this.getFiles(element.file)).map(file => {
      log.verbose("Archiver", `coping ${file}, attempt: ${element.attempt}`);

      const localFileName = path.join(LocalStorageManager.localStoragePath, element.folder || ArchiveManager.ArchiveFolder, path.basename(file));
      return fsPromise.copyFile(file, localFileName).then(
        () => { return fsPromise.unlink(file).then(r => { element.success = true; return r; }, e => log.warn("Archiver", `Unable to remove file: ${e.message}`)) },
        e => { log.warn("Archiver", `Unable to copy to local storage: ${e.message}`); },
      );
    }));
  }

  static async remove(element: Element): Promise<void[]> {
    if (!ArchiveManager.canAction(element)) {
      return [];
    }
    return Promise.all((await this.getFiles(element.file)).map(file => {
      log.verbose("Archiver", `remove ${file}, attempt: ${element.attempt}`);
      return fsPromise.unlink(file);
    })).then(
      r => { element.success = true; return r; },
      e => { log.warn("Archiver", `Unable to remove file: ${e.message}`); return [] });
  }

  static canAction(element: Element): boolean {
    return element.dateToArchive <= new Date();
  }
}
