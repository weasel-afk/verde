import { describe, expect, it } from "vitest";
import {
    FORMAT_VERSION,
    emptyTree,
    effectiveClassName,
    parseGameTree,
    serializeGameTree,
    toGameTree,
    treesEqual,
} from "../../src/gameTree";

describe("parseGameTree", () => {
    it("parses the documented fixture", () => {
        const tree = parseGameTree(`{
    "formatVersion": 1,
    "className": "DataModel",
    "children": {
        "Workspace": {
            "children": {
                "Baseplate": {
                    "className": "Part",
                    "properties": {
                        "Anchored": true,
                        "Size": { "type": "Vector3", "x": 512, "y": 20, "z": 512 },
                        "Color": { "type": "Color3", "r": 163, "g": 162, "b": 165 },
                        "Material": { "type": "Enum", "enumType": "Material", "value": "Plastic" }
                    }
                }
            }
        }
    }
}`);

        expect(tree.formatVersion).toBe(FORMAT_VERSION);
        const baseplate = tree.children?.Workspace?.children?.Baseplate;
        expect(baseplate?.className).toBe("Part");
        expect(baseplate?.properties?.Anchored).toBe(true);
        expect(baseplate?.properties?.Size).toEqual({ type: "Vector3", x: 512, y: 20, z: 512 });
        expect(baseplate?.properties?.Material).toEqual({ type: "Enum", enumType: "Material", value: "Plastic" });
    });

    it("rejects unsupported format versions", () => {
        expect(() => parseGameTree(`{"formatVersion": 2, "className": "DataModel"}`)).toThrow(/formatVersion/);
        expect(() => parseGameTree(`{"className": "DataModel"}`)).toThrow(/formatVersion/);
    });

    it("rejects unknown tagged value types", () => {
        expect(() =>
            parseGameTree(`{
            "formatVersion": 1,
            "className": "DataModel",
            "children": { "Workspace": { "properties": { "Thing": { "type": "BrickColor", "value": 1 } } } }
        }`),
        ).toThrow(/unsupported property type/);
    });

    it("rejects tagged values missing required fields", () => {
        expect(() =>
            parseGameTree(`{
            "formatVersion": 1,
            "className": "DataModel",
            "children": { "Workspace": { "properties": { "Size": { "type": "Vector3", "x": 1 } } } }
        }`),
        ).toThrow(/missing/);
    });

    it("rejects invalid JSON", () => {
        expect(() => parseGameTree("{")).toThrow(/invalid JSON/);
    });

    it("accepts empty arrays as empty maps (Luau JSONEncode output)", () => {
        const tree = parseGameTree(`{
            "formatVersion": 1,
            "className": "DataModel",
            "children": { "Chat": { "properties": [], "children": [] } }
        }`);
        expect(tree.children?.Chat).toEqual({ properties: {}, children: {} });
    });

    it("still rejects non-empty arrays", () => {
        expect(() =>
            parseGameTree(`{"formatVersion": 1, "children": { "Chat": { "children": [{}] } }}`),
        ).toThrow(/children must be an object/);
    });
});

describe("toGameTree", () => {
    it("normalizes a decoded plugin export", () => {
        const tree = toGameTree({
            formatVersion: 1,
            className: "DataModel",
            children: { Workspace: { children: { Part: { className: "Part", properties: [], children: [] } } } },
        });
        expect(tree.children?.Workspace?.children?.Part).toEqual({ className: "Part", properties: {}, children: {} });
        expect(parseGameTree(serializeGameTree(tree))).toEqual(tree);
    });

    it("rejects payloads without the format version", () => {
        expect(() => toGameTree({ className: "DataModel" })).toThrow(/formatVersion/);
        expect(() => toGameTree(null)).toThrow(/must be an object/);
    });
});

describe("serializeGameTree", () => {
    it("round-trips through parse", () => {
        const text = serializeGameTree({
            formatVersion: 1,
            className: "DataModel",
            children: {
                Workspace: {
                    children: {
                        Baseplate: {
                            className: "Part",
                            properties: { Anchored: true, Size: { type: "Vector3", x: 512, y: 20, z: 512 } },
                        },
                    },
                },
            },
        });

        expect(treesEqual(parseGameTree(text), parseGameTree(text))).toBe(true);
        const reparsed = parseGameTree(text);
        expect(reparsed.children?.Workspace?.children?.Baseplate?.properties?.Anchored).toBe(true);
    });

    it("is deterministic regardless of insertion order", () => {
        const a = serializeGameTree({
            formatVersion: 1,
            className: "DataModel",
            children: {
                Workspace: { children: { A: {}, B: {} } },
                Lighting: { properties: { Brightness: 2 } },
            },
        });
        const b = serializeGameTree({
            className: "DataModel",
            formatVersion: 1,
            children: {
                Lighting: { properties: { Brightness: 2 } },
                Workspace: { children: { B: {}, A: {} } },
            },
        });

        expect(a).toBe(b);
    });

    it("omits empty maps and ends with a newline", () => {
        const text = serializeGameTree(emptyTree());
        expect(text).toBe('{\n    "className": "DataModel",\n    "formatVersion": 1\n}\n');
    });
});

describe("effectiveClassName", () => {
    it("falls back to the key name", () => {
        expect(effectiveClassName({}, "Workspace")).toBe("Workspace");
        expect(effectiveClassName({ className: "Part" }, "Baseplate")).toBe("Part");
    });
});

describe("treesEqual", () => {
    it("ignores map key order and empty-map presence", () => {
        const a = parseGameTree(`{"formatVersion":1,"className":"DataModel","children":{"Workspace":{}}}`);
        const b = parseGameTree(
            `{"formatVersion":1,"className":"DataModel","children":{"Workspace":{"properties":{},"children":{}}}}`,
        );
        expect(treesEqual(a, b)).toBe(true);
    });

    it("detects property differences including tagged values", () => {
        const a = parseGameTree(
            `{"formatVersion":1,"className":"DataModel","children":{"Lighting":{"properties":{"Brightness":2}}}}`,
        );
        const b = parseGameTree(
            `{"formatVersion":1,"className":"DataModel","children":{"Lighting":{"properties":{"Brightness":3}}}}`,
        );
        expect(treesEqual(a, b)).toBe(false);
    });
});
