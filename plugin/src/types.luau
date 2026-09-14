local vide = require(script.Parent.packages.vide)

-- vide CanBeSource
export type CanBeSource<T> = T | vide.Source<T>

-- Component builder method
export type Component<T> = (_props: T) -> Instance

-- Toast
export type Toast = {
    Message: string,
    Severity: ("Error" | "Warn" | "Info" | string)?,
    Time: number?,
    Lifetime: number?,
}

-- A property value within the game tree. Primitives pass through raw;
-- complex values are tables tagged with a `type` key.
export type PropertyValue = boolean | number | string | { [string]: any }

-- A node within the game tree describing a single instance.
export type GameNode = {
    className: string?,
    properties: { [string]: PropertyValue },
    children: { [string]: GameNode },
}

-- The game tree document (game.json).
export type GameTree = {
    formatVersion: number,
    className: string,
    properties: { [string]: PropertyValue },
    children: { [string]: GameNode },
}

-- An action from a heartbeat payload to apply to the instance tree.
export type TreeAction = {
    action: "create" | "change" | "update" | "delete" | string,
    path: { string },
    className: string?,
    properties: { [string]: PropertyValue }?,
    value: string?,
}

return nil
