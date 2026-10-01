--[[
	Types

	Shared types for the game.json tree format (format version 1).
]]

export type PropertyValue = boolean | number | string | { [string]: any }

export type GameNode = {
	className: string?,
	properties: { [string]: PropertyValue },
	children: { [string]: GameNode },
}

export type GameTree = {
	formatVersion: number,
	className: string,
	properties: { [string]: PropertyValue },
	children: { [string]: GameNode },
}

export type TreeAction = {
	action: "create" | "update" | "delete" | string,
	path: { string },
	className: string?,
	properties: { [string]: PropertyValue }?,
}

return nil
