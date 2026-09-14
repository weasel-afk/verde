--[[
    Config

    These values are put into the state store when the plugin starts,
    This can be seen as a read-only version of the intial plugin state.
]]
type SettingUpdateFn = (_key: string, _oldValue: unknown, _newValue: unknown) -> nil

local DEFAULT_CONFIG = table.freeze {
    -- Plugin
    PLUGIN_NAME = "Verde",
    HOST = "localhost",
    PORT = 34872,
    VERSION = "v0.1.0-beta",
    HEARTBEAT_INTERVAL = 0.2,
    MENUS = {
        home = "rbxassetid://10734940825",
        settings = "rbxassetid://10734950309",
    },
}

type DefaultSettings = {
    [string]: {
        Name: string,
        Type: string,
        Default: any,
    },
}

local DEFAULT_SETTINGS = table.freeze {
    ShowToasts = {
        Name = "Show Toasts",
        Type = "Checkbox",
        Default = true,
    },
    Host = {
        Name = "Host",
        Type = "Text",
        Default = "localhost",
    },
    Port = {
        Name = "Port",
        Type = "Text",
        Default = "34872",
    },
} :: DefaultSettings

type Config = {
    init: (_plugin: Plugin) -> (),
    getSettings: () -> DefaultSettings,
    getSetting: <T>(_key: string) -> T,
    updateSetting: (_key: string, _value: unknown) -> (),
    settingUpdated: (_onUpdate: (_key: string, _oldValue: unknown, _newValue: unknown) -> nil) -> nil,
    getConfig: () -> { [string]: any },
}

type _Config = {
    _plugin: Plugin?,
    _settingCache: {
        [string]: unknown,
    },
    _settingListeners: {
        [number]: SettingUpdateFn,
    },
}

local Config = {
    _plugin = nil,
    _settingCache = {},
    _settingListeners = {},
} :: _Config & Config

--[[
    Provides the plugin instance. The plugin global only exists in the
    entry script, so it must be handed to the config module before any
    settings are read (the store reads settings at require time).
]]
function Config.init(_plugin: Plugin)
    Config._plugin = _plugin
end

--[[
    Retrieves the plugin, erroring clearly when it was not provided.
]]
local function pluginInstance(): Plugin
    local instance = Config._plugin
    if not instance then
        return error("Config.init(plugin) must be called before reading settings", 2)
    end

    return instance
end

--[[
    Retrieves the setting from studio or creates a new setting
]]
function get<T>(_key: string): T
    -- Settings are persisted with a Verde prefix (see set below).
    local val = pluginInstance():GetSetting(`Verde{_key}`)
    if val == nil then
        local defaultValue = DEFAULT_SETTINGS[_key].Default
        set(_key, defaultValue)
        return defaultValue
    end

    return val
end

--[[
    Updates a setting value
]]
function set(_key: string, _value: unknown)
    local oldValue = Config._settingCache[_key]
    local doUpdate = oldValue ~= _value
    Config._settingCache[_key] = _value
    if doUpdate then
        local instance = pluginInstance()
        task.spawn(instance.SetSetting, instance, `Verde{_key}`, _value)
    end

    for _, v in Config._settingListeners do
        v(_key, oldValue, _value)
    end
end

--[[
    Retrieves all the settings
]]
function Config.getSettings()
    return DEFAULT_SETTINGS
end

--[[
    Retrieves a setting value
]]
function Config.getSetting<T>(_key: string): T
    if Config._settingCache[_key] ~= nil then
        return Config._settingCache[_key] :: T
    end

    return get(_key)
end

--[[
    Updates a setting value
]]
function Config.updateSetting(_key: string, _value: unknown)
    set(_key, _value)
end

--[[
	Calls on update method when setting has changed
]]
function Config.settingUpdated(_onUpdate: SettingUpdateFn)
    return table.insert(Config._settingListeners, _onUpdate)
end

--[[
    Returns the config values
]]
function Config.getConfig()
    return DEFAULT_CONFIG
end

return Config :: Config
