"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
module.exports = function loadProvider(globals = {}) {
    const sandbox = { exports: {}, setTimeout, clearTimeout, ...globals };
    vm.createContext(sandbox);
    const filename = path.join(__dirname, "../dist/main.js");
    vm.runInContext(fs.readFileSync(filename, "utf8") + "\nexports.buildResponsesInput = buildResponsesInput;", sandbox, { filename });
    return sandbox.exports;
};
