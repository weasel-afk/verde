--[[
    Decoder

    Applies heartbeat tree actions to the DataModel: creates, property
    updates, script source changes and deletes. Every mutation goes
    through pcall so one bad action cannot abort a batch.
]]
local types = require(script.Parent.Parent.types)

local Decoder = {}

--[[
    Decodes a game tree property value into a Roblox value. Returns
    success and the decoded value.
]]
function Decoder.decodeValue(value: unknown): (boolean, unknown)
    if typeof(value) ~= "table" then
        return true, value
    end

    local tagged = value :: { [string]: any }
    local valueType = tagged.type

    if valueType == "Vector2" then
        return true, Vector2.new(tagged.x, tagged.y)
    elseif valueType == "Vector3" then
        return true, Vector3.new(tagged.x, tagged.y, tagged.z)
    elseif valueType == "Color3" then
        return true, Color3.fromRGB(tagged.r, tagged.g, tagged.b)
    elseif valueType == "UDim" then
        return true, UDim.new(tagged.scale, tagged.offset)
    elseif valueType == "UDim2" then
        return true, UDim2.new(tagged.scaleX, tagged.offsetX, tagged.scaleY, tagged.offsetY)
    elseif valueType == "Enum" then
        local item = resolveEnumMember(tagged.enumType, tagged.value)
        if not item then
            return false, `unknown enum {tagged.enumType}.{tagged.value}`
        end

        return true, item
    elseif valueType == "CFrame" then
        local position = tagged.position
        local rotation = tagged.rotation
        return true,
            CFrame.new(
                position.x,
                position.y,
                position.z,
                rotation[1],
                rotation[2],
                rotation[3],
                rotation[4],
                rotation[5],
                rotation[6],
                rotation[7],
                rotation[8],
                rotation[9]
            )
    elseif valueType == "Rect" then
        return true, Rect.new(tagged.min.x, tagged.min.y, tagged.max.x, tagged.max.y)
    elseif valueType == "Font" then
        local weight = tagged.weight and resolveEnumMember("FontWeight", tagged.weight)
        local style = tagged.style and resolveEnumMember("FontStyle", tagged.style)

        local ok, font = pcall(function()
            return Font.new(tagged.family, weight or Enum.FontWeight.Regular, style or Enum.FontStyle.Normal)
        end)
        return ok, font
    end

    return false, `unsupported property type {valueType}`
end

--[[
    Resolves an enum member by type and name, returning nil when unknown.
]]
function resolveEnumMember(enumType: string, member: string): EnumItem?
    local ok, enum = pcall(function()
        return (Enum :: any)[enumType]
    end)
    if not ok or not enum then
        return nil
    end

    local okMember, item = pcall(function()
        return (enum :: any)[member]
    end)
    if not okMember or not item then
        return nil
    end

    return item :: EnumItem
end

--[[
    Resolves an instance path such as { "Workspace", "Baseplate" }.
    The first segment resolves as a service (falling back to a child of
    the DataModel); .luau extensions from file sync paths are stripped.
]]
function Decoder.resolve(path: { string }): Instance?
    if #path == 0 then
        return nil
    end

    local current: Instance? = resolveSegment(game, path[1])
    for index = 2, #path do
        if not current then
            return nil
        end
        current = resolveSegment(current, path[index])
    end

    return current
end

--[[
    Resolves a single path segment within a parent.
]]
function resolveSegment(parent: Instance, segment: string): Instance?
    local name = segment
    if string.sub(name, -5) == ".luau" then
        name = string.sub(name, 1, #name - 5)
    end

    if parent == game then
        local ok, service = pcall(game.GetService, game, name)
        if ok then
            return service
        end

        return game:FindFirstChild(name)
    end

    return parent:FindFirstChild(name)
end

--[[
    Applies a batch of tree actions in order. Returns the number applied
    and the failure messages.
]]
function Decoder.apply(actions: { types.TreeAction }): { applied: number, failed: { string } }
    local result = { applied = 0, failed = {} }

    for _, action in actions do
        local ok, err = pcall(function()
            if action.action == "create" then
                applyCreate(action)
            elseif action.action == "update" then
                applyProperties(action.path, action.properties or {})
            elseif action.action == "change" then
                local instance = Decoder.resolve(action.path)
                assert(instance, "instance not found")
(instance :: any).Source = action.value
            elseif action.action == "delete" then
                assert(#action.path > 1, "refusing to delete a top level service")

                local instance = Decoder.resolve(action.path)
                assert(instance, "instance not found")
(instance :: Instance):Destroy()
            else
                error(`unknown action {action.action}`)
            end
        end)

        if ok then
            result.applied += 1
        else
            table.insert(result.failed, `{table.concat(action.path, ".")}: {err}`)
        end
    end

    return result
end

--[[
    Applies a create action. Setting an existing same-named instance of
    the same class is treated as an update, keeping re-delivered actions
    idempotent. The parent is set last.
]]
function applyCreate(action: types.TreeAction)
    local path = action.path
    assert(#path > 0, "create path is empty")

    local name = path[#path]
    local class = action.className or name
    local parent: Instance
    if #path == 1 then
        parent = game
    else
        local parentPath = { table.unpack(path, 1, #path - 1) }
        local resolved = Decoder.resolve(parentPath)
        assert(resolved, `parent instance not found`)

        parent = resolved :: Instance
    end

    -- Idempotence guard for heartbeat re-delivery.
    local existing = parent:FindFirstChild(name)
    if existing and existing.ClassName == class then
        applyPropertiesTo(existing, action.properties or {})
        return
    end

    local instance = Instance.new(class)
    instance.Name = name
    applyPropertiesTo(instance, action.properties or {})
    instance.Parent = parent
end

--[[
    Resolves an instance and applies a property map to it.
]]
function applyProperties(path: { string }, props: { [string]: types.PropertyValue })
    local instance = Decoder.resolve(path)
    assert(instance, `instance not found`)

    applyPropertiesTo(instance, props)
end

--[[
    Applies a property map to an instance, skipping values that fail to
    decode or set.
]]
function applyPropertiesTo(instance: Instance, props: { [string]: types.PropertyValue })
    for name, value in props do
        local ok, decoded = Decoder.decodeValue(value)
        if ok then
            pcall(function()
                (instance :: any)[name] = decoded
            end)
        end
    end
end

return Decoder
