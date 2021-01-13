/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neil Enns. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type TriggerFlags = {
  registered: boolean;
  confidenceThresholdMet: boolean;
  blockingMaskOverlap: boolean;
  activeRegionOverlap: boolean;
  isTriggered: boolean;
};
