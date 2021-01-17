/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neil Enns. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import ArchiveManager from "../../src/handlers/archiveManager/ArchiveManager";

test("Verify Archive Manager", async () => {
  // Empty constructor should default to enabled true
  const files = await ArchiveManager.getFiles("/aiinput/2021/01/14/NVR_01_20210114103511.jpg");
  // eslint-disable-next-line no-console
  console.log(files);
  expect(files).toBe([]);
}); 
