/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** API Base URL - Tiny Todo API base URL */
  "apiBaseUrl": string,
  /** API Token - Bearer token used for Tiny Todo API requests */
  "apiToken": string,
  /** Default Status Filter - Initial status filter when opening Manage Tasks */
  "defaultStatus": "open" | "done" | "all"
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `manage-tasks` command */
  export type ManageTasks = ExtensionPreferences & {}
  /** Preferences accessible in the `add-task` command */
  export type AddTask = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `manage-tasks` command */
  export type ManageTasks = {}
  /** Arguments passed to the `add-task` command */
  export type AddTask = {}
}

