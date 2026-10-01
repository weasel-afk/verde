local PropertyTracker = require(script.Parent.Parent.Shared.PropertyTracker)
local InstanceMap = require(script.Parent.Parent.Shared.InstanceMap)

local ReflectionService = game:GetService("ReflectionService")

local allCapabilities = SecurityCapabilities.new(table.unpack(Enum.SecurityCapability:GetEnumItems()))

local UNSAFE_PROPERTIES = {
	BrickColor = true,
	Parent = true,
	ClassName = true,
	Disabled = true,
	Source = true,
	LinkedSource = true,
	Capabilities = true,
	Sandboxed = true,
	RobloxLocked = true,
}

local reflectedPropertiesCache = {}
local enumValuesCache = {}

local function getReflectedProperties(className: string)
	local cached = reflectedPropertiesCache[className]
	if cached ~= nil then
		return cached
	end

	local properties = ReflectionService:GetPropertiesOfClass(className, {
		Security = allCapabilities,
		ExcludeInherited = false,
		ExcludeDisplay = false,
	})

	reflectedPropertiesCache[className] = properties
	return properties
end

local function isDeprecated(reflectedProperty)
	local display = reflectedProperty.Display
	if not display then
		return false
	end

	return display.DeprecationMessage ~= nil
end

local function getPropertyTypeName(reflectedProperty)
	local propertyType = reflectedProperty.Type
	if not propertyType then
		return "Unknown"
	end

	if propertyType.EngineType == "Enum" then
		return propertyType.EnumType or "Enum"
	end

	if propertyType.ScriptType == "Instance" then
		return propertyType.InstanceType or "Instance"
	end

	return propertyType.ScriptType or propertyType.EngineType or "Unknown"
end

local function isEnumType(reflectedProperty)
	local propertyType = reflectedProperty.Type
	return propertyType ~= nil and propertyType.EngineType == "Enum"
end

local function getEnumValues(enumTypeName: string)
	local cached = enumValuesCache[enumTypeName]
	if cached ~= nil then
		return cached or nil
	end

	local success, enumTable = pcall(function()
		return Enum[enumTypeName]
	end)

	if not success or not enumTable then
		enumValuesCache[enumTypeName] = false
		return nil
	end

	local enumValues = {}
	for _, enumItem in enumTable:GetEnumItems() do
		table.insert(enumValues, {
			name = enumItem.Name,
			value = enumItem.Value,
		})
	end

	enumValuesCache[enumTypeName] = enumValues
	return enumValues
end

local function isWritable(reflectedProperty)
	local permits = reflectedProperty.Permits
	if not permits then
		return false
	end

	return permits.Write ~= nil or permits.WriteParallel ~= nil
end

return function(operation)
	local nodeId = operation.nodeId
	local instance = InstanceMap[nodeId]

	if not instance then
		return false
	end

	local className = instance.ClassName
	local reflectedProperties = getReflectedProperties(className)

	if not reflectedProperties then
		return false
	end

	local safeProperties = {}
	for _, reflectedProperty in ipairs(reflectedProperties) do
		local propertyName = reflectedProperty.Name

		if UNSAFE_PROPERTIES[propertyName] then
			continue
		end

		if isDeprecated(reflectedProperty) then
			continue
		end

		local propType = getPropertyTypeName(reflectedProperty)

		local success, propValue = pcall(function()
			return instance[propertyName]
		end)

		if not success then
			continue
		end

		if isEnumType(reflectedProperty) and typeof(propValue) == "EnumItem" then
			propValue = {
				Value = propValue.Value,
				Name = propValue.Name,
			}
		end

		if typeof(propValue) == "CFrame" then
			propValue = {
				Position = {
					X = math.round(propValue.Position.X * 1000) / 1000,
					Y = math.round(propValue.Position.Y * 1000) / 1000,
					Z = math.round(propValue.Position.Z * 1000) / 1000,
				},
				Rotation = {
					X = propValue.LookVector.X,
					Y = propValue.LookVector.Y,
					Z = propValue.LookVector.Z,
				},
			}
		elseif typeof(propValue) == "Vector3" then
			propValue = {
				X = math.round(propValue.X * 1000) / 1000,
				Y = math.round(propValue.Y * 1000) / 1000,
				Z = math.round(propValue.Z * 1000) / 1000,
			}
		elseif typeof(propValue) == "Vector2" then
			propValue = {
				X = propValue.X,
				Y = propValue.Y,
			}
		elseif typeof(propValue) == "UDim2" then
			propValue = {
				X = {
					Scale = propValue.X.Scale,
					Offset = propValue.X.Offset,
				},
				Y = {
					Scale = propValue.Y.Scale,
					Offset = propValue.Y.Offset,
				},
			}
		elseif typeof(propValue) == "UDim" then
			propValue = {
				Scale = propValue.Scale,
				Offset = propValue.Offset,
			}
		elseif typeof(propValue) == "Color3" then
			propValue = {
				R = propValue.R,
				G = propValue.G,
				B = propValue.B,
			}
		elseif typeof(propValue) == "NumberRange" then
			propValue = {
				Min = propValue.Min,
				Max = propValue.Max,
			}
		elseif typeof(propValue) == "NumberSequence" then
			local keypoints = {}
			for _, keypoint in propValue.Keypoints do
				table.insert(keypoints, {
					Time = keypoint.Time,
					Value = keypoint.Value,
				})
			end
			propValue = {
				Keypoints = keypoints,
			}
		elseif typeof(propValue) == "ColorSequence" then
			local keypoints = {}
			for _, keypoint in propValue.Keypoints do
				local value = keypoint.Value
				if typeof(value) == "Color3" then
					table.insert(keypoints, {
						Time = keypoint.Time,
						Value = {
							R = value.R,
							G = value.G,
							B = value.B,
						},
					})
				else
					table.insert(keypoints, {
						Time = keypoint.Time,
						Value = value,
					})
				end
			end
			propValue = {
				Keypoints = keypoints,
			}
		end

		local enumValues = nil
		local isEnum = isEnumType(reflectedProperty)
		if isEnum then
			enumValues = getEnumValues(propType)
		end

		local referencedInstanceId = nil
		local referencedInstanceName = nil
		local referencedInstanceClass = nil
		if typeof(propValue) == "Instance" then
			for id, inst in InstanceMap do
				if inst == propValue then
					referencedInstanceId = id
					referencedInstanceName = inst.Name
					referencedInstanceClass = inst.ClassName
					break
				end
			end
		end

		local category = "Other"
		if reflectedProperty.Display and reflectedProperty.Display.Category then
			category = reflectedProperty.Display.Category
		end

		local layoutOrder = nil
		if reflectedProperty.Display and reflectedProperty.Display.LayoutOrder then
			layoutOrder = reflectedProperty.Display.LayoutOrder
		end

		local isReadOnly = not isWritable(reflectedProperty)

		table.insert(safeProperties, {
			name = propertyName,
			type = propType,
			value = propValue,
			category = category,
			layoutOrder = layoutOrder,
			isEnum = isEnum,
			enumValues = enumValues,
			isInstanceReference = typeof(propValue) == "Instance",
			referencedInstanceId = referencedInstanceId,
			referencedInstanceName = referencedInstanceName,
			referencedInstanceClass = referencedInstanceClass,
			isReadOnly = isReadOnly,
		})
	end

	local tags = instance:GetTags()

	local attributes = {}
	local success, attributesTable = pcall(function()
		return instance:GetAttributes()
	end)

	if success and attributesTable then
		for attrName, attrValue in attributesTable do
			local attrType = typeof(attrValue)
			local serializedValue = attrValue

			if typeof(attrValue) == "Color3" then
				serializedValue = {
					R = attrValue.R,
					G = attrValue.G,
					B = attrValue.B,
				}
			elseif typeof(attrValue) == "Vector3" then
				serializedValue = {
					X = math.round(attrValue.X * 1000) / 1000,
					Y = math.round(attrValue.Y * 1000) / 1000,
					Z = math.round(attrValue.Z * 1000) / 1000,
				}
			elseif typeof(attrValue) == "Vector2" then
				serializedValue = {
					X = attrValue.X,
					Y = attrValue.Y,
				}
			elseif typeof(attrValue) == "UDim2" then
				serializedValue = {
					X = {
						Scale = attrValue.X.Scale,
						Offset = attrValue.X.Offset,
					},
					Y = {
						Scale = attrValue.Y.Scale,
						Offset = attrValue.Y.Offset,
					},
				}
			elseif typeof(attrValue) == "UDim" then
				serializedValue = {
					Scale = attrValue.Scale,
					Offset = attrValue.Offset,
				}
			elseif typeof(attrValue) == "NumberRange" then
				serializedValue = {
					Min = attrValue.Min,
					Max = attrValue.Max,
				}
			end

			table.insert(attributes, {
				name = attrName,
				type = attrType,
				value = serializedValue,
			})
		end
	end

	local result = {
		properties = safeProperties,
		tags = tags,
		attributes = attributes,
	}

	PropertyTracker.setupTracking(nodeId)

	return result
end
