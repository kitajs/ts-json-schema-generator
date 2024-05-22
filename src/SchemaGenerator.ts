import ts from "typescript";
import { NoRootTypeError } from "./Error/NoRootTypeError.js";
import { Context, NodeParser } from "./NodeParser.js";
import { Definition } from "./Schema/Definition.js";
import { Schema } from "./Schema/Schema.js";
import { BaseType } from "./Type/BaseType.js";
import { DefinitionType } from "./Type/DefinitionType.js";
import { TypeFormatter } from "./TypeFormatter.js";
import { StringMap } from "./Utils/StringMap.js";
import { localSymbolAtNode, symbolAtNode } from "./Utils/symbolAtNode.js";
import { removeUnreachable } from "./Utils/removeUnreachable.js";
import { Config } from "./Config.js";
import { hasJsDocTag } from "./Utils/hasJsDocTag.js";

export class SchemaGenerator {
    public constructor(
        protected readonly program: ts.Program,
        protected readonly nodeParser: NodeParser,
        protected readonly typeFormatter: TypeFormatter,
        protected readonly config?: Config,
    ) {}

    public createSchema(fullName?: string): Schema {
        const rootNodes = this.getRootNodes(fullName);
        return this.createSchemaFromNodes(rootNodes);
    }

    public createSchemaFromNodes(rootNodes: ts.Node[]): Schema {
        const rootTypes = rootNodes.map((rootNode) => {
            return this.nodeParser.createType(rootNode, new Context());
        });

        const rootTypeDefinition = rootTypes.length === 1 ? this.getRootTypeDefinition(rootTypes[0]) : undefined;
        const definitions: StringMap<Definition> = {};
        rootTypes.forEach((rootType) => this.appendRootChildDefinitions(rootType, definitions));

        const reachableDefinitions = removeUnreachable(rootTypeDefinition, definitions);

        return {
            ...(this.config?.schemaId ? { $id: this.config.schemaId } : {}),
            $schema: "http://json-schema.org/draft-07/schema#",
            ...(rootTypeDefinition ?? {}),
            definitions: reachableDefinitions,
        };
    }

    protected getRootNodes(fullName: string | undefined): ts.Node[] {
        if (fullName && fullName !== "*") {
            return [this.findNamedNode(fullName)];
        } else {
            const rootFileNames = this.program.getRootFileNames();
            const rootSourceFiles = this.program
                .getSourceFiles()
                .filter((sourceFile) => rootFileNames.includes(sourceFile.fileName));
            const rootNodes = new Map<string, ts.Node>();
            this.appendTypes(rootSourceFiles, this.program.getTypeChecker(), rootNodes);
            return [...rootNodes.values()];
        }
    }
    protected findNamedNode(fullName: string): ts.Node {
        const typeChecker = this.program.getTypeChecker();
        const allTypes = new Map<string, ts.Node>();
        const { projectFiles, externalFiles } = this.partitionFiles();

        this.appendTypes(projectFiles, typeChecker, allTypes);

        if (allTypes.has(fullName)) {
            return allTypes.get(fullName)!;
        }

        this.appendTypes(externalFiles, typeChecker, allTypes);

        if (allTypes.has(fullName)) {
            return allTypes.get(fullName)!;
        }

        throw new NoRootTypeError(fullName);
    }
    protected getRootTypeDefinition(rootType: BaseType): Definition {
        return this.typeFormatter.getDefinition(rootType);
    }
    protected appendRootChildDefinitions(rootType: BaseType, childDefinitions: StringMap<Definition>): void {
        const seen = new Set<string>();

        const children = this.typeFormatter
            .getChildren(rootType)
            .filter((child): child is DefinitionType => child instanceof DefinitionType)
            .filter((child) => {
                if (!seen.has(child.getId())) {
                    seen.add(child.getId());
                    return true;
                }
                return false;
            });

        const ids = new Map<string, string>();
        for (const child of children) {
            const name = child.getName();
            const previousId = ids.get(name);
            // remove def prefix from ids to avoid false alarms
            // FIXME: we probably shouldn't be doing this as there is probably something wrong with the deduplication
            const childId = child.getId().replace(/def-/g, "");

            if (previousId && childId !== previousId) {
                throw new Error(`Type "${name}" has multiple definitions.`);
            }
            ids.set(name, childId);
        }

        children.reduce((definitions, child) => {
            const name = child.getName();
            if (!(name in definitions)) {
                definitions[name] = this.typeFormatter.getDefinition(child.getType());
            }
            return definitions;
        }, childDefinitions);
    }
    protected partitionFiles(): {
        projectFiles: ts.SourceFile[];
        externalFiles: ts.SourceFile[];
    } {
        const projectFiles = new Array<ts.SourceFile>();
        const externalFiles = new Array<ts.SourceFile>();

        for (const sourceFile of this.program.getSourceFiles()) {
            const destination = sourceFile.fileName.includes("/node_modules/") ? externalFiles : projectFiles;
            destination.push(sourceFile);
        }

        return { projectFiles, externalFiles };
    }
    protected appendTypes(
        sourceFiles: readonly ts.SourceFile[],
        typeChecker: ts.TypeChecker,
        types: Map<string, ts.Node>,
    ): void {
        for (const sourceFile of sourceFiles) {
            this.inspectNode(sourceFile, typeChecker, types);
        }
    }
    protected inspectNode(
        node: ts.Node,
        typeChecker: ts.TypeChecker,
        allTypes: Map<string, ts.Node>,
        forceExpose = false,
    ): void {
        switch (node.kind) {
            case ts.SyntaxKind.VariableDeclaration: {
                const variableDeclarationNode = node as ts.VariableDeclaration;
                if (
                    variableDeclarationNode.initializer?.kind === ts.SyntaxKind.ArrowFunction ||
                    variableDeclarationNode.initializer?.kind === ts.SyntaxKind.FunctionExpression
                ) {
                    this.inspectNode(variableDeclarationNode.initializer, typeChecker, allTypes);
                }
                return;
            }
            case ts.SyntaxKind.InterfaceDeclaration:
            case ts.SyntaxKind.ClassDeclaration:
            case ts.SyntaxKind.EnumDeclaration:
            case ts.SyntaxKind.TypeAliasDeclaration:
                if (
                    forceExpose ||
                    this.config?.expose === "all" ||
                    (this.isExportType(node) && !this.isGenericType(node as ts.TypeAliasDeclaration))
                ) {
                    allTypes.set(this.getFullName(node, typeChecker), node);
                    return;
                }
                return;
            case ts.SyntaxKind.ConstructorType:
            case ts.SyntaxKind.FunctionDeclaration:
            case ts.SyntaxKind.FunctionExpression:
            case ts.SyntaxKind.ArrowFunction:
                allTypes.set(this.getFullName(node, typeChecker), node);
                return;
            case ts.SyntaxKind.ExportSpecifier: {
                const exportSpecifierNode = node as ts.ExportSpecifier;
                const symbol = typeChecker.getExportSpecifierLocalTargetSymbol(exportSpecifierNode);

                // should never hit this (maybe type error in user's code)
                if (!symbol || !symbol.declarations) {
                    return;
                }

                for (const declaration of symbol.declarations) {
                    if (declaration.kind === ts.SyntaxKind.ImportSpecifier) {
                        // Handling the `Foo` in `import { Foo } from "./lib"; export { Foo };`
                        const importSpecifierNode = declaration as ts.ImportSpecifier;

                        const symbol =
                            typeChecker.getTypeAtLocation(importSpecifierNode).symbol ||
                            typeChecker.getSymbolAtLocation(importSpecifierNode) ||
                            importSpecifierNode.symbol;

                        // should never hit this (maybe type error in user's code)
                        if (!symbol?.declarations) {
                            return;
                        }

                        for (const declaration of symbol.declarations) {
                            // all statements here were inside a export { Foo } statement,
                            // so they must be exported

                            // recursion doesn't work here
                            if (ts.isImportSpecifier(declaration)) {
                                // directly import/exported nodes.
                                const symbol =
                                    typeChecker.getTypeAtLocation(declaration).symbol ||
                                    typeChecker.getSymbolAtLocation(declaration) ||
                                    declaration.symbol;

                                // should never hit this (maybe type error in user's code)
                                if (!symbol?.declarations) {
                                    console.log(symbol);
                                    return;
                                }

                                for (const subdecl of symbol.declarations) {
                                    console.log(subdecl.kind, subdecl.getText());
                                }
                            } else {
                                this.inspectNode(declaration, typeChecker, allTypes, true);
                            }
                        }
                    } else {
                        // Handling the `Bar` in `export { Bar } from './lib';`
                        this.inspectNode(declaration, typeChecker, allTypes, true);
                    }
                }
                return;
            }
            case ts.SyntaxKind.ExportDeclaration: {
                if (!ts.isExportDeclaration(node)) {
                    return;
                }

                if (!node.moduleSpecifier) {
                    if (!node.exportClause) {
                        throw new Error(
                            `ExportDeclaration has no moduleSpecifier or exportClause: ${node.pos === -1 ? "<unresolved>" : node.getText()}`,
                        );
                    }

                    if (ts.isNamespaceExport(node.exportClause)) {
                        throw new Error(
                            `Namespace exports are not supported: ${node.pos === -1 ? "<unresolved>" : node.getText()}`,
                        );
                    }

                    for (const element of node.exportClause.elements) {
                        this.inspectNode(element, typeChecker, allTypes);
                    }

                    return;
                }

                const symbol = typeChecker.getSymbolAtLocation(node.moduleSpecifier);

                // should never hit this (maybe type error in user's code)
                if (!symbol || !symbol.declarations) {
                    return;
                }

                // module augmentation can result in more than one source file
                for (const source of symbol.declarations) {
                    const sourceSymbol = typeChecker.getSymbolAtLocation(source);

                    if (!sourceSymbol) {
                        throw new Error(
                            `Could not find symbol for SourceFile at ${(source as ts.SourceFile).fileName}`,
                        );
                    }

                    const moduleExports = typeChecker.getExportsOfModule(sourceSymbol);

                    for (const moduleExport of moduleExports) {
                        const nodes =
                            moduleExport.declarations ||
                            (!!moduleExport.valueDeclaration && [moduleExport.valueDeclaration]);

                        // should never hit this (maybe type error in user's code)
                        if (!nodes) {
                            return;
                        }

                        for (const node of nodes) {
                            this.inspectNode(node, typeChecker, allTypes);
                        }
                    }
                }

                return;
            }
            default:
                ts.forEachChild(node, (subnode) => this.inspectNode(subnode, typeChecker, allTypes));
                return;
        }
    }
    protected isExportType(node: ts.Node): boolean {
        if (this.config?.jsDoc !== "none" && hasJsDocTag(node, "internal")) {
            return false;
        }
        const localSymbol = localSymbolAtNode(node);
        return localSymbol ? "exportSymbol" in localSymbol : false;
    }
    protected isGenericType(node: ts.TypeAliasDeclaration): boolean {
        return !!(node.typeParameters && node.typeParameters.length > 0);
    }
    protected getFullName(node: ts.Node, typeChecker: ts.TypeChecker): string {
        const symbol = symbolAtNode(node)!;
        return typeChecker.getFullyQualifiedName(symbol).replace(/".*"\./, "");
    }
}
