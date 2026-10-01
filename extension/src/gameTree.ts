export const FORMAT_VERSION = 1;

export type PrimitiveValue = boolean | number | string;

export type TaggedValue =
    | { type: "Vector2"; x: number; y: number }
    | { type: "Vector3"; x: number; y: number; z: number }
    | { type: "Color3"; r: number; g: number; b: number }
    | { type: "UDim"; scale: number; offset: number }
    | { type: "UDim2"; scaleX: number; offsetX: number; scaleY: number; offsetY: number }
    | { type: "Enum"; enumType: string; value: string }
    | { type: "CFrame"; position: { x: number; y: number; z: number }; rotation: number[] }
    | { type: "Rect"; min: { x: number; y: number }; max: { x: number; y: number } }
    | { type: "Font"; family: string; weight?: string; style?: string };

export type PropertyValue = PrimitiveValue | TaggedValue;

export type GameNode = {
    className?: string;
    properties?: Record<string, PropertyValue>;
    children?: Record<string, GameNode>;
};

export type GameTree = GameNode & {
    formatVersion: number;
    className: string;
};

/** The required fields of every tagged value type. */
const TAGGED_FIELDS: Record<string, string[]> = {
    Vector2: ["x", "y"],
    Vector3: ["x", "y", "z"],
    Color3: ["r", "g", "b"],
    UDim: ["scale", "offset"],
    UDim2: ["scaleX", "offsetX", "scaleY", "offsetY"],
    Enum: ["enumType", "value"],
    CFrame: ["position", "rotation"],
    Rect: ["min", "max"],
    Font: ["family"],
};

/**
 * An empty game tree: no services, no properties. Used as the baseline
 * before the first Studio export.
 */
export function emptyTree(): GameTree {
    return {
        formatVersion: FORMAT_VERSION,
        className: "DataModel",
        properties: {},
        children: {},
    };
}

/**
 * The class name of a node, falling back to the name it is keyed under.
 */
export function effectiveClassName(node: GameNode, name: string): string {
    return node.className ?? name;
}

/**
 * Parses and validates a game tree document. Unknown format versions and
 * unknown tagged value types are rejected.
 */
export function parseGameTree(text: string): GameTree {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new Error(`invalid JSON: ${String(err)}`);
    }
    return toGameTree(parsed);
}

/**
 * Validates an already-decoded game tree (e.g. a plugin export) and
 * normalizes every node to `{className?, properties, children}`.
 */
export function toGameTree(parsed: unknown): GameTree {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("the tree root must be an object");
    }
    const record = parsed as Record<string, unknown>;
    const formatVersion = record.formatVersion;
    if (formatVersion !== FORMAT_VERSION) {
        throw new Error(`unsupported formatVersion ${String(formatVersion)} (expected ${FORMAT_VERSION})`);
    }

    const root = validateNode(parsed, []);
    return {
        formatVersion: FORMAT_VERSION,
        className: root.className ?? "DataModel",
        properties: root.properties,
        children: root.children,
    };
}

function validateNode(value: unknown, path: string[]): GameNode {
    const where = path.length === 0 ? "the tree root" : path.join(".");
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${where} must be an object`);
    }

    const record = value as Record<string, unknown>;

    const node: GameNode = {};
    if (record.className !== undefined) {
        if (typeof record.className !== "string") {
            throw new Error(`${where} className must be a string`);
        }
        node.className = record.className;
    }

    return {
        ...node,
        properties: record.properties !== undefined ? validateProperties(record.properties, path) : {},
        children: record.children !== undefined ? validateChildren(record.children, path) : {},
    };
}

/**
 * Luau's JSONEncode writes an empty table as `[]`, so plugin exports carry
 * empty property and child maps as empty arrays.
 */
function isEmptyArray(value: unknown): boolean {
    return Array.isArray(value) && value.length === 0;
}

function validateProperties(value: unknown, path: string[]): Record<string, PropertyValue> {
    if (isEmptyArray(value)) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${path.join(".") || "root"} properties must be an object`);
    }

    const properties: Record<string, PropertyValue> = {};
    for (const [name, propertyValue] of Object.entries(value)) {
        properties[name] = validatePropertyValue(propertyValue, [...path, name]);
    }
    return properties;
}

function validatePropertyValue(value: unknown, path: string[]): PropertyValue {
    const where = path.join(".");

    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
        return value;
    }

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${where} must be a primitive or a tagged value object`);
    }

    const record = value as Record<string, unknown>;
    const type = record.type;
    if (typeof type !== "string") {
        throw new Error(`${where} tagged value is missing a string "type"`);
    }

    const requiredFields = TAGGED_FIELDS[type];
    if (!requiredFields) {
        throw new Error(`${where} has unsupported property type "${type}"`);
    }
    for (const field of requiredFields) {
        if (record[field] === undefined) {
            throw new Error(`${where} tagged value of type "${type}" is missing "${field}"`);
        }
    }

    return value as PropertyValue;
}

function validateChildren(value: unknown, path: string[]): Record<string, GameNode> {
    if (isEmptyArray(value)) {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${path.join(".") || "root"} children must be an object`);
    }

    const children: Record<string, GameNode> = {};
    for (const [name, child] of Object.entries(value)) {
        children[name] = validateNode(child, [...path, name]);
    }
    return children;
}

/**
 * Serializes a game tree deterministically: keys sorted at every level,
 * four-space indent, trailing newline. Empty root property and child maps
 * are omitted, as is an absent className.
 */
export function serializeGameTree(tree: GameTree): string {
    const object: Record<string, unknown> = {
        formatVersion: tree.formatVersion,
        className: tree.className,
    };
    if (tree.properties && Object.keys(tree.properties).length > 0) {
        object.properties = tree.properties;
    }
    if (tree.children && Object.keys(tree.children).length > 0) {
        object.children = tree.children;
    }

    return stringifySorted(object, 0) + "\n";
}

function stringifySorted(value: unknown, depth: number): string {
    const indent = "    ".repeat(depth);
    const innerIndent = "    ".repeat(depth + 1);

    if (typeof value !== "object" || value === null) {
        return JSON.stringify(value) ?? "null";
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return "[]";
        }
        const items = value.map((item) => `${innerIndent}${stringifySorted(item, depth + 1)}`);
        return `[\n${items.join(",\n")}\n${indent}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    if (entries.length === 0) {
        return "{}";
    }
    const items = entries.map(
        ([key, entryValue]) => `${innerIndent}${JSON.stringify(key)}: ${stringifySorted(entryValue, depth + 1)}`,
    );
    return `{\n${items.join(",\n")}\n${indent}}`;
}

/**
 * Deep structural equality of two game trees. Map key order is ignored.
 */
export function treesEqual(a: GameTree | GameNode, b: GameTree | GameNode): boolean {
    return nodesEqual(a, b);
}

function nodesEqual(a: GameNode, b: GameNode): boolean {
    if ((a.className ?? "") !== (b.className ?? "")) {
        return false;
    }

    const aProperties = a.properties ?? {};
    const bProperties = b.properties ?? {};
    if (!mapsEqual(aProperties, bProperties, propertyValuesEqual)) {
        return false;
    }

    const aChildren = a.children ?? {};
    const bChildren = b.children ?? {};
    const aNames = Object.keys(aChildren);
    const bNames = Object.keys(bChildren);
    if (aNames.length !== bNames.length) {
        return false;
    }
    for (const name of aNames) {
        if (!(name in bChildren) || !nodesEqual(aChildren[name], bChildren[name])) {
            return false;
        }
    }
    return true;
}

function mapsEqual<T>(
    a: Record<string, T>,
    b: Record<string, T>,
    valuesEqual: (x: T, y: T) => boolean,
): boolean {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
        return false;
    }
    for (const key of aKeys) {
        if (!(key in b) || !valuesEqual(a[key], b[key])) {
            return false;
        }
    }
    return true;
}

function propertyValuesEqual(a: PropertyValue, b: PropertyValue): boolean {
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
        return a === b;
    }

    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord);
    const bKeys = Object.keys(bRecord);
    if (aKeys.length !== bKeys.length) {
        return false;
    }
    for (const key of aKeys) {
        if (!(key in bRecord)) {
            return false;
        }
        const aValue = aRecord[key];
        const bValue = bRecord[key];
        if (Array.isArray(aValue) || Array.isArray(bValue)) {
            if (!Array.isArray(aValue) || !Array.isArray(bValue) || aValue.length !== bValue.length) {
                return false;
            }
            for (let i = 0; i < aValue.length; i++) {
                if (!propertyValuesEqual(aValue[i] as PropertyValue, bValue[i] as PropertyValue)) {
                    return false;
                }
            }
        } else if (!propertyValuesEqual(aValue as PropertyValue, bValue as PropertyValue)) {
            return false;
        }
    }
    return true;
}

/**
 * Clones a game tree. The result shares no references with the original.
 */
export function cloneTree<T extends GameTree | GameNode>(tree: T): T {
    return structuredClone(tree);
}
