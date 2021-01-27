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

class MotionEvent {

  static possiblePostfixed = ['_att'];
  static longesEventDuration = 13;
  static additionalPaths = [path.join(LocalStorageManager.localStoragePath, LocalStorageManager.Locations.Annotations)];

  eventId: string;
  startTime: Date;
  basePath: string;
  elements: Element[];

  constructor(_eventId: string, _startTime: Date, basePath: string) {
    this.eventId = _eventId;
    this.startTime = _startTime;
    this.basePath = basePath;
    this.elements = [];
  }

  public isSame(event: MotionEvent): boolean {
    return event.eventId == this.eventId && event.startTime >= this.startTime && event.startTime < moment(this.startTime).add(MotionEvent.longesEventDuration, "seconds").toDate();
  }

  public canAction(): boolean {
    return this.elements.reduce((p, c) => p && c.dateToArchive <= new Date(), true);
  }

  public async archive(move: (filePath: string, folderToMoveTo: string) => Promise<boolean>, remove: (filePath: string) => Promise<boolean>): Promise<void> {
    if (!this.canAction()) {
      return;
    }
    log.verbose("Archiver", `archiving event ${this.eventId} ${this.startTime}, with ${this.elements.length} elements.`);

    const actionForAdditionalFiles = this.elements.filter(f => f.action === 'move') ? 'move' : 'remove';
    this.elements.forEach(e => {
      if (e.action === 'move') {
        move(e.file, e.folder).then(r => e.success = r);
      } else {
        remove(e.file).then(r => e.success = r);
      }
      e.attempt++;
    });
    (await this.getPossibleFiles()).forEach(f => {
      if (actionForAdditionalFiles === 'move') {
        move(f, this.getDestinationFolderForFile(f));
      } else {
        remove(f);
      }
    });
  }

  getDestinationFolderForFile(f: string): string {
    if (f.indexOf(LocalStorageManager.Locations.Annotations) >= 0) {
      return path.join(ArchiveManager.ArchiveFolder, LocalStorageManager.Locations.Annotations);
    }
    return null;
  }

  public isArchived(): boolean {
    return this.elements.filter(e => !e.success && e.attempt <= 3).length == 0;
  }

  public addElement(element: Element) {

    const existing = this.elements.filter(e => e.file == element.file && e.folder == element.folder)[0];
    if (!existing) {
      this.elements.push(element);
    }
    else {
      if (existing.action == "remove") {
        existing.action = element.action;
        existing.attempt = 0;
        existing.dateAdded = element.dateAdded;
        existing.dateToArchive = element.dateToArchive
      }
    }
  }
  public async getPossibleFiles(): Promise<string[]> {
    const fileNameBases = [this.basePath, ...MotionEvent.additionalPaths].map(p => `${path.join(p, this.eventId)}`);

    const fileNameBasesWithPostfixes = [].concat(...['', ...MotionEvent.possiblePostfixed].map(p => fileNameBases.map(b => b + p)));

    const fileNameBasesWithPostfixesAndTimes = [].concat(
      ...Array.from(Array<number>(MotionEvent.longesEventDuration).keys())
        .map(t => fileNameBasesWithPostfixes.map(f => `${f}${moment(this.startTime).add(t, "seconds").format("YYYYMMDDHHmmss")}`))
    );

    const fullFileNames = [].concat(...['.mp4', '.jpg'].map(e => fileNameBasesWithPostfixesAndTimes.map(f => f + e)));

    const filePromises = fullFileNames
      .map(async f => {
        try {
          const s = await fsPromise.stat(f);
          return s.isFile() ? f : null;
        } catch (e) {
          return null;
        }
      })
      .filter(f => f != null);

    return [
      ...(await Promise.all(filePromises)).filter(r => r != null)
    ];
  }

  static getFromFilePath(filePath: string): MotionEvent {
    const fileBaseName = path.basename(filePath);
    const lastUnderscoreIndex = fileBaseName.lastIndexOf('_');
    const fileNameDateString = fileBaseName.substring(lastUnderscoreIndex + 1, fileBaseName.length - 4);
    const eventStartTime = moment(fileNameDateString, "YYYYMMDDHHmmss").add(-3, "seconds");
    const eventId = this.possiblePostfixed.reduce((p, c) => p.replace(c, ''), fileBaseName.substring(0, lastUnderscoreIndex + 1));
    return new MotionEvent(eventId, eventStartTime.toDate(), path.dirname(filePath));
  }
}

export default class ArchiveManager {
  private static archiverLog: MotionEvent[];
  private static _backgroundTimer: NodeJS.Timeout;

  public static readonly ArchiveFolder = "archive";
  public static readonly SemiMatchedFolder = "maybeMatched";

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
    const result = Promise.all(ArchiveManager.archiverLog.map(event => {
      return event.archive(ArchiveManager.move, ArchiveManager.remove);
    })).then(() => {
      ArchiveManager.archiverLog = ArchiveManager.archiverLog.filter(e => !e.isArchived());
    });

    ArchiveManager._backgroundTimer = setTimeout(ArchiveManager.runLog, 6000);

    return result;
  }

  static markFileForAction(fileName: string, action: string, config: ArchiveConfig, folder?: string,): void {
    const event = MotionEvent.getFromFilePath(fileName);
    let existing = ArchiveManager.archiverLog.filter(el => el.isSame(event))[0];

    if (!existing) {
      ArchiveManager.archiverLog.push(event);
      existing = event;
    }
    existing.addElement({ action: action, file: fileName, attempt: 0, success: false, folder: folder, dateAdded: new Date(), dateToArchive: new Date(new Date().getTime() + config.timeToKeep) });
  }

  static async move(filePath: string, folderToMoveTo: string): Promise<boolean> {
    log.verbose("Archiver", `coping ${filePath}`);

    const localFileName = path.join(LocalStorageManager.localStoragePath, folderToMoveTo || ArchiveManager.ArchiveFolder, path.basename(filePath));
    return fsPromise.copyFile(filePath, localFileName).then(
      () => { return fsPromise.unlink(filePath).then(r => { return true; }, e => { log.warn("Archiver", `Unable to remove file: ${e.message}`); return false; }) },
      e => { log.warn("Archiver", `Unable to copy to local storage: ${e.message}`); return false; }
    );
  }

  static async remove(filePath: string): Promise<boolean> {
    log.verbose("Archiver", `remove ${filePath}`);
    return fsPromise.unlink(filePath)
      .then(
        () => { return true; },
        e => { log.warn("Archiver", `Unable to remove file: ${e.message}`); return false; });
  }
}
