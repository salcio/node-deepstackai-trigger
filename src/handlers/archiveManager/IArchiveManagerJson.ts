/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neil Enns. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export default interface IArchiveManagerJson {
  enabled: boolean;
  // milliseconds to keep file before archiving
  timeToKeep: number;
  // should we archive images blocked by masks into semidetached folder ?
  semiMatchedArchiveEnabled: boolean;
}
