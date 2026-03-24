erDiagram
    SOFTWARE_PRODUCT ||--o{ PRODUCT_VERSION : "has"
    PRODUCT_VERSION ||--o{ BOM_RELEASE : "has"
    BOM_RELEASE ||--o{ BOM_COMPONENT : "contains"
    MODULE_TYPE ||--o{ BOM_COMPONENT : "categorizes"
    HARDWARE_PLATFORM ||--o{ BOM_COMPONENT : "supports"
    HARDWARE_PLATFORM ||--o{ PROJECT_ARCH_MAP : "maps"
    PROJECT ||--o{ PROJECT_ARCH_MAP : "uses"
    PROJECT ||--o{ PROJECT_ASSET_SELECTION : "selects"
    BOM_COMPONENT ||--o{ PROJECT_ASSET_SELECTION : "selected_in"
    SOFTWARE_PRODUCT ||--o{ PROJECT_ASSET_SELECTION : "被选中"

    SOFTWARE_PRODUCT {
        string id PK
        string name
        string description
    }

    PRODUCT_VERSION {
        string id PK
        string product_id FK
        string version_number
    }

    BOM_RELEASE {
        string id PK
        string version_id FK
        string title
        string wiki_url
        datetime release_date
    }

    BOM_COMPONENT {
        string id PK
        string release_id FK
        string module_type_id FK
        string arch_id FK
        string component_name
        string component_id_str
        string version
        string original_url
        string bom_md5
        string api_md5
        string local_md5
        string remark
    }

    MODULE_TYPE {
        string id PK
        string name
    }

    HARDWARE_PLATFORM {
        string id PK
        string code
        string description
    }

    PROJECT {
        string id PK
        string name
        string customer_name
        datetime created_at
    }

    PROJECT_ARCH_MAP {
        string project_id PK,FK
        string arch_id PK,FK
    }

    PROJECT_ASSET_SELECTION {
        string id PK
        string project_id FK
        string component_id FK
    }