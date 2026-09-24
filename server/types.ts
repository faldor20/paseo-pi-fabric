import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";

// Server-only shared types: never import this module from shared/ or client/,
// which bundle for both runtimes. Sourced from the plugin server entry because
// @getpaseo/protocol only exposes a wildcard subpath export, which the plugin
// install-time resolver cannot see.
export type AgentTimelineItem =
  PluginLifecycleEvents["agent.turn_ended"]["timeline"][number];
