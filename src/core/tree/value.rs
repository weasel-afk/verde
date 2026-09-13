// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
use serde::{Deserialize, Serialize};

/// A 2D vector used within complex property values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Vec2 {
  /// The x component.
  pub x: f64,

  /// The y component.
  pub y: f64,
}

/// A 3D vector used within complex property values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Vec3 {
  /// The x component.
  pub x: f64,

  /// The y component.
  pub y: f64,

  /// The z component.
  pub z: f64,
}

/// A primitive property value, serialised as a raw JSON value.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Primitive {
  /// A boolean property.
  Bool(bool),

  /// A number property.
  Number(f64),

  /// A string property.
  String(String),
}

/// A complex property value, serialised as an object tagged with a `type` key.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Complex {
  /// A Vector2 value.
  Vector2 {
    x: f64,
    y: f64,
  },

  /// A Vector3 value.
  Vector3 {
    x: f64,
    y: f64,
    z: f64,
  },

  /// A Color3 value with 0-255 components (matching `Color3.fromRGB`).
  Color3 {
    r: f64,
    g: f64,
    b: f64,
  },

  /// A UDim value.
  UDim {
    scale: f64,
    offset: f64,
  },

  /// A UDim2 value.
  #[serde(rename_all = "camelCase")]
  UDim2 {
    scale_x: f64,
    offset_x: f64,
    scale_y: f64,
    offset_y: f64,
  },

  /// An enum value referenced by enum type and member name.
  #[serde(rename_all = "camelCase")]
  Enum {
    enum_type: String,
    value: String,
  },

  /// A CFrame value with a position and a row-major 3x3 rotation matrix.
  #[serde(rename_all = "camelCase")]
  CFrame {
    position: Vec3,
    rotation: [f64; 9],
  },

  /// A Rect value.
  Rect {
    min: Vec2,
    max: Vec2,
  },

  /// A Font value. Weight and style are enum member names.
  #[serde(rename_all = "camelCase")]
  Font {
    family: String,
    weight: Option<String>,
    style: Option<String>,
  },
}

/// The value of an instance property within the game tree.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PropertyValue {
  /// A primitive (raw JSON) value.
  Primitive(Primitive),

  /// A complex (type tagged) value.
  Complex(Complex),
}
