//! Android: секреты (токен Zvuk, ключ YouTube) шифруются ключом из Android Keystore (AES-256-GCM,
//! Kotlin: ZgSecrets.kt). Ключ не покидает защищённое хранилище телефона, поэтому копия файлов
//! приложения без самого телефона бесполезна. Вызов через JNI — без перехода в главный поток.
//! Если Keystore недоступен, Store сохранит значение как есть (только в закрытой папке приложения).

use std::path::Path;

#[cfg(target_os = "android")]
fn call(method: &str, arg: &str) -> Option<String> {
    use jni::objects::{JClass, JObject, JString, JValue};
    let ctx = ndk_context::android_context();
    if ctx.vm().is_null() || ctx.context().is_null() {
        return None;
    }
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.ok()?;
    let mut env = vm.attach_current_thread().ok()?;
    let result = (|| -> jni::errors::Result<Option<String>> {
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };
        // классы приложения видны только через его загрузчик (FindClass из чужого потока их не найдёт)
        let loader = env.call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?.l()?;
        let name = env.new_string("com.zvukglass.app.ZgSecrets")?;
        let cls = env.call_method(&loader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", &[JValue::Object(&name)])?.l()?;
        let cls = JClass::from(cls);
        let jarg = env.new_string(arg)?;
        let out = env.call_static_method(&cls, method, "(Ljava/lang/String;)Ljava/lang/String;", &[JValue::Object(&jarg)])?.l()?;
        if out.is_null() {
            return Ok(None);
        }
        let s: String = env.get_string(&JString::from(out))?.into();
        Ok(Some(s))
    })();
    match result {
        Ok(v) => v,
        Err(_) => {
            // исключение Java не должно уронить приложение
            let _ = env.exception_clear();
            None
        }
    }
}

#[cfg(not(target_os = "android"))]
fn call(_method: &str, _arg: &str) -> Option<String> {
    None
}

pub fn seal(text: &str) -> Option<String> {
    call("seal", text)
}

pub fn open(b64: &str) -> Option<String> {
    call("open", b64)
}

pub fn open_electron(_data_dir: &Path, _b64: &str) -> Option<String> {
    None
}
