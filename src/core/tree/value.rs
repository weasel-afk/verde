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
  Vector2 { x: f64, y: f64 },

  /// A Vector3 value.
  Vector3 { x: f64, y: f64, z: f64 },

  /// A Color3 value with 0-255 components (matching `Color3.fromRGB`).
  Color3 { r: f64, g: f64, b: f64 },

  /// A UDim value.
  UDim { scale: f64, offset: f64 },

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
  Enum { enum_type: String, value: String },

  /// A CFrame value with a position and a row-major 3x3 rotation matrix.
  #[serde(rename_all = "camelCase")]
  CFrame { position: Vec3, rotation: [f64; 9] },

  /// A Rect value.
  Rect { min: Vec2, max: Vec2 },

  /// A Font value. Weight and style are enum member names.
  #[serde(rename_all = "camelCase")]
  Font {
    family: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    weight: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
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

#[cfg(test)]
mod tests {
  use super::*;

  /// Round trips a value through JSON.
  fn round_trip(value: &PropertyValue) -> PropertyValue {
    let json = serde_json::to_string(value).unwrap();
    serde_json::from_str(&json).unwrap()
  }

  #[test]
  fn primitives_serialise_as_raw_json() {
    let cases = [
      (Primitive::Bool(true), "true"),
      (Primitive::Number(1.5), "1.5"),
      (Primitive::Number(4.0), "4.0"),
      (
        Primitive::String(String::from("rbxassetid://1234")),
        "\"rbxassetid://1234\"",
      ),
    ];

    for (primitive, golden) in cases {
      let value = PropertyValue::Primitive(primitive.clone());
      assert_eq!(serde_json::to_string(&value).unwrap(), golden);
      assert_eq!(round_trip(&value), value);
    }
  }

  #[test]
  fn complex_values_round_trip() {
    let cases = [
      PropertyValue::Complex(Complex::Vector2 { x: 0.5, y: 0.5 }),
      PropertyValue::Complex(Complex::Vector3 {
        x: 512.0,
        y: 20.0,
        z: 512.0,
      }),
      PropertyValue::Complex(Complex::Color3 {
        r: 163.0,
        g: 162.0,
        b: 165.0,
      }),
      PropertyValue::Complex(Complex::UDim {
        scale: 0.5,
        offset: 12.0,
      }),
      PropertyValue::Complex(Complex::UDim2 {
        scale_x: 0.0,
        offset_x: 200.0,
        scale_y: 0.0,
        offset_y: 50.0,
      }),
      PropertyValue::Complex(Complex::Enum {
        enum_type: String::from("Material"),
        value: String::from("Neon"),
      }),
      PropertyValue::Complex(Complex::CFrame {
        position: Vec3 { x: 1.0, y: 2.0, z: 3.0 },
        rotation: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
      }),
      PropertyValue::Complex(Complex::Rect {
        min: Vec2 { x: 0.0, y: 0.0 },
        max: Vec2 { x: 100.0, y: 100.0 },
      }),
      PropertyValue::Complex(Complex::Font {
        family: String::from("rbxasset://fonts/families/SourceSansPro.json"),
        weight: Some(String::from("SemiBold")),
        style: None,
      }),
    ];

    for value in cases {
      assert_eq!(round_trip(&value), value);
    }
  }

  #[test]
  fn complex_values_serialise_to_golden_json() {
    let cases = [
      (
        PropertyValue::Complex(Complex::Vector3 {
          x: 512.0,
          y: 20.0,
          z: 512.0,
        }),
        r#"{"type":"Vector3","x":512.0,"y":20.0,"z":512.0}"#,
      ),
      (
        PropertyValue::Complex(Complex::UDim2 {
          scale_x: 0.5,
          offset_x: 0.0,
          scale_y: 0.5,
          offset_y: 0.0,
        }),
        r#"{"type":"UDim2","scaleX":0.5,"offsetX":0.0,"scaleY":0.5,"offsetY":0.0}"#,
      ),
      (
        PropertyValue::Complex(Complex::Enum {
          enum_type: String::from("Material"),
          value: String::from("Neon"),
        }),
        r#"{"type":"Enum","enumType":"Material","value":"Neon"}"#,
      ),
      (
        PropertyValue::Complex(Complex::Color3 {
          r: 255.0,
          g: 0.0,
          b: 0.0,
        }),
        r#"{"type":"Color3","r":255.0,"g":0.0,"b":0.0}"#,
      ),
      (
        PropertyValue::Complex(Complex::Font {
          family: String::from("rbxasset://fonts/families/Arimo.json"),
          weight: None,
          style: None,
        }),
        r#"{"type":"Font","family":"rbxasset://fonts/families/Arimo.json"}"#,
      ),
    ];

    for (value, golden) in cases {
      assert_eq!(serde_json::to_string(&value).unwrap(), golden);
    }
  }

  #[test]
  fn unknown_type_tags_are_rejected() {
    let json = r#"{"type":"Wibble","x":1.0}"#;
    assert!(serde_json::from_str::<PropertyValue>(json).is_err());
  }
}
