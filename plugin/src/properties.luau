--[[
    Properties

    Curated per-class property lists controlling which properties are
    exported into game.json. Property reads go through pcall, so any
    listed property an instance does not actually have is skipped.

    The apply engine is NOT limited to this table: any property written in
    game.json is set on the target instance.
]]

-- Properties exported for an exact class name.
local CLASS_PROPERTIES: { [string]: { string } } = {
    Part = { "Shape" },
    WedgePart = { "Shape" },
    SpawnLocation = { "AllowTeamChangeOnTouch", "Duration", "Neutral" },

    ScreenGui = { "DisplayOrder", "Enabled", "IgnoreGuiInset", "ResetOnSpawn", "ZIndexBehavior" },
    SurfaceGui = { "Active", "AlwaysOnTop", "Brightness", "CanvasSize", "Face", "LightInfluence", "ZOffset" },
    BillboardGui = { "Active", "AlwaysOnTop", "LightInfluence", "MaxDistance", "SizeOffset", "StudsOffset" },

    TextLabel = {
        "FontFace",
        "RichText",
        "Text",
        "TextColor3",
        "TextScaled",
        "TextSize",
        "TextTransparency",
        "TextWrapped",
        "TextXAlignment",
        "TextYAlignment",
    },
    TextBox = { "ClearTextOnFocus", "MultiLine", "PlaceholderText" },
    TextButton = { "AutoButtonColor", "Modal" },
    ImageLabel = {
        "Image",
        "ImageColor3",
        "ImageRectOffset",
        "ImageRectSize",
        "ImageTransparency",
        "ScaleType",
        "SliceCenter",
        "TileSize",
    },
    ImageButton = { "AutoButtonColor" },
    ScrollingFrame = { "CanvasSize", "ElasticBehavior", "ScrollBarThickness", "ScrollingDirection" },
    UIListLayout = { "FillDirection", "HorizontalAlignment", "Padding", "SortOrder", "VerticalAlignment" },
    UIPadding = { "PaddingBottom", "PaddingLeft", "PaddingRight", "PaddingTop" },
    UICorner = { "CornerRadius" },
    UIStroke = { "ApplyStrokeMode", "Color", "Thickness", "Transparency" },

    ModuleScript = { "Source" },
    Script = { "RunContext" },
    LocalScript = {},

    Lighting = {
        "Ambient",
        "Brightness",
        "ClockTime",
        "EnvironmentDiffuseScale",
        "EnvironmentSpecularScale",
        "ExposureCompensation",
        "FogColor",
        "FogEnd",
        "FogStart",
        "GlobalShadows",
        "OutdoorAmbient",
        "ShadowSoftness",
        "Technology",
    },
    Atmosphere = { "Color", "Decay", "Density", "Glare", "Haze", "Offset" },

    Sound = {
        "Looped",
        "PlaybackSpeed",
        "RollOffMaxDistance",
        "RollOffMinDistance",
        "RollOffMode",
        "SoundId",
        "Volume",
    },
    SpotLight = { "Angle", "Face" },
    SurfaceLight = { "Angle", "Face", "LightStyle" },
    Texture = { "StudsPerTileU", "StudsPerTileV" },
    Attachment = { "Axis", "Orientation", "Position", "SecondaryAxis" },
}

-- Properties exported for every class inheriting the key (via IsA).
local BASE_PROPERTIES: { [string]: { string } } = {
    BasePart = {
        "Anchored",
        "CanCollide",
        "CanQuery",
        "CanTouch",
        "CastShadow",
        "Color",
        "Material",
        "Massless",
        "Orientation",
        "Position",
        "Reflectance",
        "Size",
        "Transparency",
    },
    GuiObject = {
        "Active",
        "AnchorPoint",
        "AutomaticSize",
        "BackgroundColor3",
        "BackgroundTransparency",
        "BorderColor3",
        "BorderSizePixel",
        "ClipsDescendants",
        "LayoutOrder",
        "Position",
        "Rotation",
        "Selectable",
        "Size",
        "SizeConstraint",
        "Visible",
        "ZIndex",
    },
    BaseScript = { "Disabled", "Source" },
    Light = { "Brightness", "Color", "Enabled", "Range", "Shadows" },
    Decal = { "Face", "Texture", "Transparency" },
}

local Properties = {}

--[[
    Lists the exported property names for an instance: the exact class
    list plus every inherited base list, deduplicated.
]]
function Properties.list(instance: Instance): { string }
    local names: { [string]: boolean } = {}
    local list = {}

    local function add(name: string)
        if not names[name] then
            names[name] = true
            table.insert(list, name)
        end
    end

    for _, name in CLASS_PROPERTIES[instance.ClassName] or {} do
        add(name)
    end
    for base, baseNames in BASE_PROPERTIES do
        if instance:IsA(base) then
            for _, name in baseNames do
                add(name)
            end
        end
    end

    return list
end

return Properties
