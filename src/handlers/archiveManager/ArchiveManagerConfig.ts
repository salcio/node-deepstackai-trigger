/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neil Enns. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
export default class ArchiveConfig {
  public enabled: boolean;
  // should we archive images blocked by masks into semidetached folder ?
  public semiMatchedArchiveEnabled: boolean;
  // milliseconds to keep file before archiving
  public timeToKeep: number;

  constructor(init?: Partial<ArchiveConfig>) {
    Object.assign(this, init);

    // Default for enabled is true if it isn't specified in the config file
    this.enabled = init?.enabled ?? true;
    this.semiMatchedArchiveEnabled = init?.semiMatchedArchiveEnabled ?? false;
    this.timeToKeep = init?.timeToKeep ?? 60000;
  }
}
