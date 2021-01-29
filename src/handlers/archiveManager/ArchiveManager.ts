/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neil Enns. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as log from "../../Log";
import Trigger from "../../Trigger";

import mkdirp from "mkdirp";
import path from "path";
import { promises as fsPromise } from "fs";
import glob from "glob"

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
  static longesEventDuration = 15;
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

  replace(event: MotionEvent) {
    this.eventId = event.eventId;
    this.startTime = event.startTime <= this.startTime ? event.startTime : this.startTime;
    this.basePath = event.basePath;
    this.elements = this.elements.concat(event.elements);
  }

  public isSame(event: MotionEvent): { same: boolean, rightOrder?: boolean } {
    if (event.eventId != this.eventId) {
      return { same: false };
    }
    if (event.startTime >= this.startTime && event.startTime < moment(this.startTime).add(MotionEvent.longesEventDuration, "seconds").toDate()) {
      return { same: true, rightOrder: true };
    }
    if (this.startTime >= event.startTime && this.startTime < moment(event.startTime).add(MotionEvent.longesEventDuration, "second").toDate()) {
      return { same: true, rightOrder: false };
    }
    return { same: false };
  }

  public canAction(): boolean {
    return this.elements.reduce((p, c) => p && c.dateToArchive <= new Date(), true);
  }

  public async archive(move: (filePath: string, folderToMoveTo: string) => Promise<boolean>, remove: (filePath: string) => Promise<boolean>, checkTimeToKeep: boolean): Promise<void[]> {
    if (checkTimeToKeep && !this.canAction()) {
      return;
    }
    const eventMainAction = this.elements.filter(f => f.action === 'move').length > 0 ? 'move' : 'remove';
    const destinationFolder = this.elements.filter(f => f.action === 'move' && f.folder).map(f => f.folder).reduce((p, c) => (c == p || c == null) ? p : p == null ? c : null, null);

    log.info("Archiver", `archiving event ${this.eventId} ${this.startTime}, with ${this.elements.length} elements. Event main action is '${eventMainAction}' and destination folder is '${destinationFolder}'`);

    const result = await Promise.all(this.elements.map(async e => {
      e.attempt++;
      if (e.action === 'move' || eventMainAction === 'move') {
        e.success = await move(e.file, this.getDestinationFolderForFile(e.file, destinationFolder || e.folder));
        return;
      }
      e.success = await remove(e.file);
      return;
    }).concat(
      this.getPossibleFiles().filter(f => this.elements.filter(e => e.file == f).length == 0).map(async f => {
        if (eventMainAction === 'move') {
          await move(f, this.getDestinationFolderForFile(f, destinationFolder));
          return;
        }
        await remove(f);
        return;
      })));

    log.info("Archiver", `archiving of event ${this.eventId} ${this.startTime} finished. Result isArchived ${this.isArchived()}.`);

    if (!this.isArchived()) {
      log.warn("Archiver", `elements: ${JSON.stringify(this.elements)}`);
    }

    return result;
  }

  getDestinationFolderForFile(f: string, folder: string): string {
    let subFolder = "";
    if (f.indexOf(LocalStorageManager.Locations.Annotations) >= 0) {
      subFolder = LocalStorageManager.Locations.Annotations;
    }
    return path.join(folder || ArchiveManager.ArchiveFolder, moment(this.startTime).format('YYYY/MM/DD'), this.eventId, moment(this.startTime).format('HHmmss'), subFolder);
  }

  public isArchived(): boolean {
    return this.elements.filter(e => !e.success && e.attempt <= 3).length == 0;
  }

  public addElement(element: Element) {
    const existing = this.elements.filter(e => e.file == element.file)[0];
    if (!existing) {
      this.elements.push(element);
    }
    else {
      if (existing.action == "remove") {
        existing.action = element.action;
        existing.attempt = 0;
        existing.dateAdded = element.dateAdded;
        existing.dateToArchive = element.dateToArchive
        existing.folder = element.folder;
      }
    }
  }
  public getPossibleFiles(): string[] {
    const fileNameBases = [this.basePath, ...MotionEvent.additionalPaths].map(p => `${path.join(p, this.eventId)}`);

    const fileNameBasesWithPostfixes = [].concat(...['', ...MotionEvent.possiblePostfixed].map(p => fileNameBases.map(b => b + p)));

    const fileNameBasesWithPostfixesAndTimes = [].concat(
      ...Array.from(Array<number>(MotionEvent.longesEventDuration).keys())
        .map(t => fileNameBasesWithPostfixes.map(f => `${f}${moment(this.startTime).add(t, "seconds").format("YYYYMMDDHHmmss*")}`))
    );

    const fullFileNames = [].concat(...['.mp4', '.jpg'].map(e => fileNameBasesWithPostfixesAndTimes.map(f => f + e)));
    const files = [].concat(...fullFileNames
      .map(f => {
        try {
          return glob.sync(f, { absolute: true });
        } catch (e) {
          return [];
        }
      }))
      .filter(f => f != null);
    log.verbose('Archiver', `possible files: ${fullFileNames}`);

    return files;
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
    return ArchiveManager.runLog(true);
  }

  public static async initialize(): Promise<void> {
    await mkdirp(path.join(LocalStorageManager.localStoragePath, ArchiveManager.ArchiveFolder));
    await mkdirp(path.join(LocalStorageManager.localStoragePath, ArchiveManager.SemiMatchedFolder));
    await mkdirp(path.join(LocalStorageManager.localStoragePath, ArchiveManager.ArchiveFolder, LocalStorageManager.Locations.Annotations));
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

  public static async runLog(shutdown?: boolean): Promise<void> {
    ArchiveManager.archiverLog = ArchiveManager.archiverLog || [];

    await Promise.all(ArchiveManager.archiverLog.map(event => event.archive(ArchiveManager.move, ArchiveManager.remove, !shutdown)));

    ArchiveManager.archiverLog = ArchiveManager.archiverLog.filter(e => !e.isArchived());

    ArchiveManager._backgroundTimer = setTimeout(ArchiveManager.runLog, 6000);
  }

  static markFileForAction(fileName: string, action: string, config: ArchiveConfig, folder?: string,): void {
    const event = MotionEvent.getFromFilePath(fileName);
    let existing = ArchiveManager.archiverLog.map(el => ({ el, same: el.isSame(event) })).filter(e => e.same.same)[0];

    if (!existing) {
      log.info('Archiver', `Adding new event ${event.eventId}/${event.startTime}`)
      ArchiveManager.archiverLog.push(event);
      existing = { el: event, same: { same: false } };
    }

    if (existing.same.same && !existing.same.rightOrder) {
      existing.el.replace(event);
    }

    existing.el.addElement({ action: action, file: fileName, attempt: 0, success: false, folder: folder, dateAdded: new Date(), dateToArchive: new Date(new Date().getTime() + config.timeToKeep) });
  }

  static async move(filePath: string, folderToMoveTo: string): Promise<boolean> {
    log.verbose("Archiver", `moving ${filePath} to ${folderToMoveTo || ArchiveManager.ArchiveFolder}`);

    const localFilePath = path.join(LocalStorageManager.localStoragePath, folderToMoveTo || ArchiveManager.ArchiveFolder);
    const localFileName = path.join(localFilePath, path.basename(filePath));

    if (!await fsPromise.mkdir(localFilePath, { recursive: true }).then(() => true, e => { log.warn("Archiver", `Unable to create destination folder file: ${localFilePath} ${e.message}`); return false; })) {
      return;
    }

    return fsPromise.copyFile(filePath, localFileName).then(
      () => { return fsPromise.unlink(filePath).then(() => { return true; }, e => { log.warn("Archiver", `Unable to remove file: ${e.message}`); return false; }) },
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
