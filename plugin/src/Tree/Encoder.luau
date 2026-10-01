--[[
	Encoder

	Walks the DataModel and produces a game tree table for game.json,
	restricted to an allowlist of services and curated properties. The
	walk yields periodically and gives up past a soft node cap, returning
	nil so the caller can report the tree as too big.
]]

local properties = require(script.Parent.Properties)
local types = require(script.Parent.Types)

-- Services exported when the caller does not provide any extras.
local DEFAULT_SERVICES = {
	"Workspace",
	"ReplicatedStorage",
	"ServerStorage",
	"ServerScriptService",
	"StarterGui",
	"StarterPack",
	"StarterPlayer",
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

-- The walk yields every few nodes and gives up past this many.
local MAX_NODES = 100000
local YIELD_INTERVAL = 2000

local Encoder = {}

--[[
	Encodes a Roblox value into a game tree property value. Returns nil
	for unsupported types.
]]
function Encoder.encodeValue(value: unknown): types.PropertyValue?
	local valueType = typeof(value)

	if valueType == "boolean" or valueType == "number" or valueType == "string" then
		-- JSON cannot represent non-finite numbers (e.g. RollOffMaxDistance
		-- defaults to math.huge); skip them rather than fail the export.
		if valueType == "number" then
			local number = value :: number
			if number ~= number or number == math.huge or number == -math.huge then
				return nil
			end
		end

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
		local udim2 = value :: UDim2
		return {
			type = "UDim2",
			scaleX = udim2.X.Scale,
			offsetX = udim2.X.Offset,
			scaleY = udim2.Y.Scale,
			offsetY = udim2.Y.Offset,
		}
	elseif valueType == "EnumItem" then
		local item = value :: EnumItem
		-- Enum types have no Name property; derive it from tostring, which is
		-- "PartType" on current Studio builds and "Enum.PartType" on older ones.
		local enumName = string.gsub(tostring(item.EnumType), "^Enum%.", "")
		return { type = "Enum", enumType = enumName, value = item.Name }
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
	extra service names provided by the caller. Returns nil when the
	tree exceeds the soft node cap.
]]
function Encoder.export(pluginRoot: Instance?, extraServices: { string }?): types.GameTree?
	local allowed = {}
	for _, name in DEFAULT_SERVICES do
		allowed[name] = true
	end
	for _, name in extraServices or {} do
		allowed[name] = true
	end

	local context = {
		pluginRoot = pluginRoot,
		visited = 0,
		tooBig = false,
	}

	local children = {}
	for _, service in game:GetChildren() do
		if allowed[service.Name] then
			children[service.Name] = encodeNode(service, context)
			if context.tooBig then
				return nil
			end
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
	Returns whether an instance is part of the plugin's own tree.
]]
local function isPluginTree(instance: Instance, pluginRoot: Instance?): boolean
	if not pluginRoot then
		return false
	end

	return instance == pluginRoot or instance:IsDescendantOf(pluginRoot)
end

--[[
	Encodes a single instance and its descendants.
]]
function encodeNode(
	instance: Instance,
	context: { pluginRoot: Instance?, visited: number, tooBig: boolean }
): types.GameNode
	local node: types.GameNode = {
		className = if instance.ClassName ~= instance.Name then instance.ClassName else nil,
		properties = {},
		children = {},
	}

	context.visited += 1
	if context.visited > MAX_NODES then
		context.tooBig = true
		return node
	elseif context.visited % YIELD_INTERVAL == 0 then
		task.wait()
	end

	-- Curated properties, read defensively.
	for _, name in properties.list(instance) do
		local ok, value = pcall(function()
			return (instance :: any)[name]
		end)
		if ok then
			local encodedOk, encoded = pcall(Encoder.encodeValue, value)
			if encodedOk and encoded ~= nil then
				node.properties[name] = encoded
			end
		end
	end

	for _, child in instance:GetChildren() do
		if context.tooBig then
			break
		end
		if SKIPPED_CLASSES[child.ClassName] then
			continue
		end
		if isPluginTree(child, context.pluginRoot) then
			continue
		end

		-- Children are keyed by name; duplicates cannot be represented.
		-- The first child wins and later duplicates are skipped with a
		-- warning so one collision cannot fail the whole export.
		if node.children[child.Name] ~= nil then
			warn("[verde] skipping duplicate child named " .. child.Name .. " under " .. instance:GetFullName())
			continue
		end
		node.children[child.Name] = encodeNode(child, context)
	end

	return node
end

return Encoder
