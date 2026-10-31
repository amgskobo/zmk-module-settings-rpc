// jest-dom adds custom jest matchers for asserting on DOM nodes.
import "@testing-library/jest-dom";
import { TextEncoder, TextDecoder } from "node:util";

// jsdom omits these browser APIs; use Node's actual encoders for protobuf tests.
Object.assign(globalThis, { TextEncoder, TextDecoder });
