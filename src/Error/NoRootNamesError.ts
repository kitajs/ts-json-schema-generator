import { BaseError } from "./BaseError.js";

export class NoRootNamesError extends BaseError {
    public get name(): string {
        return "NoRootNamesError";
    }
    public get message(): string {
        return `No source files found`;
    }
}
