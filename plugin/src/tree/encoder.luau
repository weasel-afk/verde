--[[
    Encoder

    Walks the DataModel and produces a game tree table for game.json,
    restricted to an allowlist of services and curated properties.
]]
local properties = require(script.Parent.Parent.properties)
local types = require(script.Parent.Parent.types)

-- Services exported when the project does not define any.
local DEFAULT_SERVICES = {
	"Workspace",
	"ReplicatedStorage",
	"ServerStorage",
	"ServerScriptService",
	"StarterGui",
	"StarterPack",
	"StarterPlayer",
	"StarterPlayerScripts",
	"Lighting",
	"SoundService",
	"Teams",
	"Chat",
	"TextChatService",
	"Players",
}

-- Classes that are never exported.
local SKIPPED_CLASSES = {
	Terrain = true,
	Camera = true,
	Player = true,
}

-- The plugin's own development tree in Workspace.
local SELF_NAME = "Verde"

local Encoder = {}

--[[
    Encodes a Roblox value into a game tree property value. Returns nil
    for unsupported types.
]]
function Encoder.encodeValue(value: unknown): types.PropertyValue?
	local valueType = typeof(value)

	if valueType == "boolean" or valueType == "number" or valueType == "string" then
		return value
	elseif valueType == "Vector2" then
		local vector = value :: Vector2
		return { type = "Vector2", x = vector.X, y = vector.Y }
	elseif valueType == "Vector3" then
		local vector = value :: Vector3
		return { type = "Vector3", x = vector.X, y = vector.Y, z = vector.Z }
	elseif valueType == "Color3" then
		local color = value :: Color3
		return {
			type = "Color3",
			r = math.floor(color.R * 255 + 0.5),
			g = math.floor(color.G * 255 + 0.5),
			b = math.floor(color.B * 255 + 0.5),
		}
	elseif valueType == "UDim" then
		local udim = value :: UDim
		return { type = "UDim", scale = udim.Scale, offset = udim.Offset }
	elseif valueType == "UDim2" then
		local udim = value :: UDim2
		return {
			type = "UDim2",
			scaleX = udim.X.Scale,
			offsetX = udim.X.Offset,
			scaleY = udim.Y.Scale,
			offsetY = udim.Y.Offset,
		}
	elseif valueType == "EnumItem" then
		local item = value :: EnumItem
		return { type = "Enum", enumType = item.EnumType.Name, value = item.Name }
	elseif valueType == "CFrame" then
		local cframe = value :: CFrame
		local x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22 = cframe:GetComponents()
		return {
			type = "CFrame",
			position = { x = x, y = y, z = z },
			rotation = { r00, r01, r02, r10, r11, r12, r20, r21, r22 },
		}
	elseif valueType == "Rect" then
		local rect = value :: Rect
		return {
			type = "Rect",
			min = { x = rect.Min.X, y = rect.Min.Y },
			max = { x = rect.Max.X, y = rect.Max.Y },
		}
	elseif valueType == "Font" then
		local font = value :: Font
		local encoded = { type = "Font", family = font.Family }
		if font.Weight ~= Enum.FontWeight.Regular then
			encoded.weight = font.Weight.Name
		end
		if font.Style ~= Enum.FontStyle.Normal then
			encoded.style = font.Style.Name
		end
		return encoded
	end

	return nil
end

--[[
    Exports the game tree, restricted to the default services plus any
    extra service names provided by the project.
]]
function Encoder.export(extraServices: { string }?): types.GameTree
	local allowed = {}
	for _, name in DEFAULT_SERVICES do
		allowed[name] = true
	end
	for _, name in extraServices or {} do
		allowed[name] = true
	end

	local children = {}
	for _, service in game:GetChildren() do
		if allowed[service.Name] then
			local skipSelf = service.Name == "Workspace"
			children[service.Name] = encodeNode(service, skipSelf)
		end
	end

	return {
		formatVersion = 1,
		className = "DataModel",
		properties = {},
		children = children,
	}
end

--[[
    Encodes a single instance and its descendants.
]]
function encodeNode(instance: Instance, skipSelf: boolean?): types.GameNode
	local node: types.GameNode = {
		className = if instance.ClassName ~= instance.Name then instance.ClassName else nil,
		properties = {},
		children = {},
	}

	-- Curated properties, read defensively.
	for _, name in properties.list(instance) do
		local ok, value = pcall(function()
			return (instance :: any)[name]
		end)
		if ok then
			local encoded = Encoder.encodeValue(value)
			if encoded ~= nil then
				node.properties[name] = encoded
			end
		end
	end

	for _, child in instance:GetChildren() do
		if SKIPPED_CLASSES[child.ClassName] then
			continue
		end
		if skipSelf and child.Name == SELF_NAME then
			continue
		end

		-- Children are keyed by name; duplicates cannot be represented.
		node.children[child.Name] = encodeNode(child)
	end

	return node
end

return Encoder
