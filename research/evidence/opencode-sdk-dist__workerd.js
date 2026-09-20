import {
  make2
} from "./chunks/workerd-39225h8g.js";
import"./chunks/workerd-ya9awdj2.js";
import"./chunks/workerd-wyq33nd6.js";
import"./chunks/workerd-pqb0kjhx.js";
import"./chunks/workerd-4k080vda.js";
import {
  create4
} from "./chunks/workerd-3tfavsrc.js";
import {
  __export
} from "./chunks/workerd-9rqn6x4v.js";

// src/workerd.ts
var exports_workerd = {};
__export(exports_workerd, {
  OpenCodeWorkerd: () => exports_workerd,
  create: () => create
});
var create = ({ log, plugins, instances, ...options }) => {
  const profile = make2(options);
  return create4({ ...profile.options, log, plugins, instances }, { overrides: profile.replacements });
};
export {
  exports_workerd as OpenCodeWorkerd,
  create
};
